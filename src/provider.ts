import { Model, Provider, type Plugin } from "@opencode/plugin"
import {
  buildAgyContextReport,
  buildAgyUsageReport,
  buildUsageSnapshotDto,
  consumePendingContextRequest,
  consumePendingSwarmRequest,
  consumePendingUsageRequest,
  discoverPlanCatalog,
  evaluateModelQuotaStatus,
  readAgyTranscriptSummary,
  type AgyPlanCatalog,
} from "./context.ts"
import { buildSanitizedEnv, resolveAgyBinary } from "./env.ts"
import { buildFailureMessage, inspectControlLine, toV3Usage } from "./output.ts"
import {
  buildInstantTitle,
  buildProviderPrompt,
  detectContextCommandInPrompt,
  detectSwarmCommandInPrompt,
  detectUsageCommandInPrompt,
  extractRelevantInstructions,
} from "./prompt.ts"
import { AgyUsageRpc } from "./rpc.ts"
import { spawnAgyProcess } from "./runner.ts"
import {
  hasActiveAgySwarm,
  readAgyAgentsSnapshot,
  type LiveStreamSubagent,
} from "./subagents.ts"
import {
  AGY_MODEL_MAP,
  AGY_MODEL_SPECS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  PROVIDER_ID,
  resolveProviderCliModel,
  type AgyConnectorConfig,
  type AgyErrorPayload,
  type AgyExecutionMode,
  type AgyJsonResult,
  type AgyMeta,
  type AgyUsage,
  type V3Usage,
} from "./types.ts"

interface StreamTurnParams {
  readonly agyBin: string
  readonly args: readonly string[]
  readonly workspaceDir: string
  readonly env: Record<string, string>
  readonly timeoutSeconds: number
  readonly abortSignal?: AbortSignal
  readonly onConversationId: (convId?: string) => void
  readonly onSubagentStep?: (
    stepIndex: number,
    state: string,
    subagents: readonly Record<string, unknown>[],
  ) => void
  readonly onSwarmOrAgentActivity?: () => void
  readonly onTurnComplete?: () => void
}

/** Build `agy -p` CLI arguments for a native OpenCode provider turn. */
export function buildStreamArgs(params: {
  readonly promptText: string
  readonly cliModel: string
  readonly timeoutSeconds: number
  readonly readOnly: boolean
  readonly mode: AgyExecutionMode
  readonly allowAllTools: boolean
  readonly enableSlashCommands?: boolean
  readonly prevConvId?: string
  readonly responseSchema?: unknown
}): string[] {
  const args: string[] = [
    "-p",
    params.promptText,
    "--model",
    params.cliModel,
    "--output-format",
    "stream-json",
  ]

  if (!params.enableSlashCommands) {
    args.push("--disable-slash-commands")
  }
  args.push("--print-timeout", `${params.timeoutSeconds}s`)

  if (!params.readOnly) {
    args.push("--mode", params.mode)
    if (params.allowAllTools) {
      args.push("--dangerously-skip-permissions")
    }
  }
  if (params.prevConvId) {
    args.push("--conversation", params.prevConvId)
  }
  if (params.responseSchema !== undefined) {
    args.push("--json-schema", JSON.stringify(params.responseSchema))
  }

  return args
}

function createEmptyPromptStream(cliModel: string): ReadableStream<any> {
  const msg = `Antigravity is active on \`${cliModel}\`. Enter a request after \`/agy <task>\` or type directly in chat.`
  return createInstantReportStream(msg, toV3Usage())
}

function createInstantReportStream(text: string, usage: V3Usage): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      controller.enqueue({ type: "text-start", id: "t_instant" })
      controller.enqueue({ type: "text-delta", id: "t_instant", delta: text })
      controller.enqueue({ type: "text-end", id: "t_instant" })
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "SUCCESS" },
        usage,
      })
      controller.close()
    },
  })
}

function createStreamingAgyStream(params: StreamTurnParams): ReadableStream<any> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })

      let timedOut = false
      let closed = false
      const { child, cleanup: cleanupProcess } = spawnAgyProcess(
        params.agyBin,
        params.args,
        params.workspaceDir,
        params.env,
        params.timeoutSeconds,
        params.abortSignal,
        () => {
          timedOut = true
        },
      )
      const liveTicker = setInterval(() => {
        params.onSwarmOrAgentActivity?.()
      }, 2500)
      const cleanup = () => {
        clearInterval(liveTicker)
        cleanupProcess()
      }

      let stdoutBuf = ""
      const rawStdoutLines: string[] = []
      const rawStderrLines: string[] = []
      let activeTextId: string | undefined
      let textCounter = 0
      let emittedAnyText = false
      let resultPayload: AgyJsonResult | undefined
      let agyError: AgyErrorPayload | undefined
      let permissionBlocked: string | undefined
      let lastStepUsage: AgyUsage | undefined
      let turnOutputTokens = 0
      let turnThinkingTokens = 0
      const countedSteps = new Set<string>()
      let finalUsage = toV3Usage()
      const startedTools = new Set<string>()
      const endedTools = new Set<string>()

      const closeActiveText = () => {
        if (activeTextId) {
          controller.enqueue({ type: "text-end", id: activeTextId })
          activeTextId = undefined
        }
      }

      const emitTextChunk = (delta: string) => {
        if (!delta) return
        emittedAnyText = true
        if (!activeTextId) {
          textCounter += 1
          activeTextId = `agy_text_${textCounter}`
          controller.enqueue({ type: "text-start", id: activeTextId })
        }
        controller.enqueue({ type: "text-delta", id: activeTextId, delta })
      }

      const stripLine = (raw: string) =>
        raw.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r\n/g, "\n").trim()

      const processNdjsonLine = (rawLine: string) => {
        const line = stripLine(rawLine)
        if (!line) return

        const ctrl = inspectControlLine(line)
        if (ctrl?.agyError) {
          agyError = ctrl.agyError
          return
        }
        if (ctrl?.permissionBlocked) {
          permissionBlocked = ctrl.permissionBlocked
          return
        }

        if (!line.startsWith("{")) {
          rawStdoutLines.push(line)
          return
        }

        let ev: Record<string, any>
        try {
          ev = JSON.parse(line) as Record<string, any>
        } catch {
          rawStdoutLines.push(line)
          return
        }

        if (ev.event === "init") {
          params.onConversationId(typeof ev.conversation_id === "string" ? ev.conversation_id : undefined)
          return
        }

        if (ev.event === "step_update" && ev.step_update) {
          const su = ev.step_update as Record<string, any>
          params.onConversationId(typeof su.conversation_id === "string" ? su.conversation_id : undefined)

          if (su.usage && typeof su.usage === "object") {
            const u = su.usage as AgyUsage
            if ((u.input_tokens ?? 0) > 0 || (u.cache_read_tokens ?? 0) > 0 || (u.output_tokens ?? 0) > 0) {
              lastStepUsage = u
              const stepKey = String(su.step_index ?? "")
              if (su.state === "DONE" && stepKey && !countedSteps.has(stepKey)) {
                countedSteps.add(stepKey)
                turnOutputTokens += u.output_tokens ?? 0
                turnThinkingTokens += u.thinking_tokens ?? 0
              }
              finalUsage = toV3Usage({
                input_tokens: lastStepUsage.input_tokens ?? 0,
                cache_read_tokens: lastStepUsage.cache_read_tokens ?? 0,
                output_tokens: turnOutputTokens > 0 ? turnOutputTokens : (lastStepUsage.output_tokens ?? 0),
                thinking_tokens: turnThinkingTokens > 0 ? turnThinkingTokens : (lastStepUsage.thinking_tokens ?? 0),
              })
            }
          }

          if (su.step_type === "tool" || su.step_type === "subagent") {
            const isSubagentStep = su.step_type === "subagent"
            const callId = `agy_step_${String(su.step_index)}`
            const toolInfo = (su.tool_info ?? {}) as Record<string, any>
            const subagentInfo = (su.subagent_info ?? {}) as Record<string, any>
            const toolName = String(
              su.tool_name || toolInfo.name || (isSubagentStep ? "invoke_subagent" : "agy_tool"),
            )
            const toolParams = isSubagentStep ? subagentInfo : (toolInfo.parameters ?? {})
            const paramsJson = JSON.stringify(toolParams)

            if (!startedTools.has(callId)) {
              closeActiveText()
              startedTools.add(callId)
              controller.enqueue({
                type: "tool-input-start",
                id: callId,
                toolName,
                providerExecuted: true,
              })
              controller.enqueue({ type: "tool-input-delta", id: callId, delta: paramsJson })
              controller.enqueue({ type: "tool-input-end", id: callId })
              controller.enqueue({
                type: "tool-call",
                toolCallId: callId,
                toolName,
                input: paramsJson,
                providerExecuted: true,
              })
            }

            if (isSubagentStep) {
              const list = Array.isArray(subagentInfo.subagents)
                ? (subagentInfo.subagents as Record<string, unknown>[])
                : []
              params.onSubagentStep?.(Number(su.step_index ?? 0), String(su.state ?? ""), list)
            } else if (
              toolName === "swarm" ||
              toolName === "post_message" ||
              toolName === "read_board" ||
              toolName === "swarm_wait" ||
              toolName === "manage_subagents" ||
              toolName === "define_subagent"
            ) {
              params.onSwarmOrAgentActivity?.()
            }

            if (su.state === "DONE" && !endedTools.has(callId)) {
              endedTools.add(callId)
              const output = isSubagentStep ? subagentInfo : toolInfo.output
              const resultVal =
                typeof output === "string"
                  ? { output }
                  : output !== undefined && output !== null
                    ? output
                    : { parameters: toolParams, status: "completed" }
              controller.enqueue({
                type: "tool-result",
                toolCallId: callId,
                toolName,
                result: resultVal,
                isError: Boolean(su.error),
              })
            }
            return
          }

          if (su.step_type === "agent_response" && typeof su.text_delta === "string" && su.text_delta.length > 0) {
            emitTextChunk(su.text_delta)
          }
          return
        }

        if (ev.event === "result" && ev.result) {
          resultPayload = ev.result as AgyJsonResult
          params.onConversationId(resultPayload.conversation_id)
          if (!lastStepUsage && resultPayload.usage) {
            finalUsage = toV3Usage(resultPayload.usage)
          }
        }
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBuf += chunk.toString("utf8")
        let idx: number
        while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
          const line = stdoutBuf.slice(0, idx)
          stdoutBuf = stdoutBuf.slice(idx + 1)
          processNdjsonLine(line)
        }
      })

      child.stderr?.on("data", (chunk: Buffer) => {
        for (const rawLine of chunk.toString("utf8").split("\n")) {
          const line = stripLine(rawLine)
          if (!line) continue
          const ctrl = inspectControlLine(line)
          if (ctrl?.agyError) {
            agyError = ctrl.agyError
          } else if (ctrl?.permissionBlocked) {
            permissionBlocked = ctrl.permissionBlocked
          } else {
            rawStderrLines.push(line)
          }
        }
      })

      child.on("error", (err) => {
        cleanup()
        if (closed) return
        closed = true
        closeActiveText()
        controller.enqueue({
          type: "error",
          error: new Error(`Failed to spawn '${params.agyBin}': ${err.message}`),
        })
        controller.enqueue({
          type: "finish",
          finishReason: { unified: "error", raw: "SPAWN_ERROR" },
          usage: finalUsage,
        })
        controller.close()
      })

      child.on("close", (code, signalName) => {
        cleanup()
        if (closed) return
        closed = true

        if (stdoutBuf.trim()) {
          processNdjsonLine(stdoutBuf)
        }

        const aborted = Boolean(params.abortSignal?.aborted)
        const failed =
          !aborted &&
          (timedOut ||
            code !== 0 ||
            Boolean(permissionBlocked) ||
            Boolean(agyError) ||
            resultPayload?.status === "ERROR")

        if (!failed && !emittedAnyText && resultPayload?.response?.trim()) {
          emitTextChunk(resultPayload.response.trim())
        }

        closeActiveText()

        if (aborted) {
          controller.enqueue({
            type: "finish",
            finishReason: { unified: "other", raw: "aborted" },
            usage: finalUsage,
          })
          controller.close()
          return
        }

        if (failed) {
          const errMsg = buildFailureMessage(code, signalName, timedOut, {
            result: resultPayload,
            agyError,
            permissionBlocked,
            cleanedStdout: rawStdoutLines.join("\n"),
            cleanedStderr: rawStderrLines.join("\n"),
          })
          controller.enqueue({ type: "error", error: new Error(errMsg) })
          controller.enqueue({
            type: "finish",
            finishReason: {
              unified: "error",
              raw: agyError?.reason ?? resultPayload?.finished_reason ?? String(code ?? "error"),
            },
            usage: finalUsage,
          })
          controller.close()
          params.onTurnComplete?.()
          return
        }

        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: resultPayload?.status ?? "SUCCESS" },
          usage: finalUsage,
        })
        controller.close()
        params.onTurnComplete?.()
      })
    },
  })
}

/** Register the native `agy/*` AI SDK model provider and session lifecycle hooks. */
export async function registerAgyProvider(
  ctx: Plugin.Context,
  config: AgyConnectorConfig,
): Promise<() => Promise<void>> {
  const workspaceDir = ctx.location.directory
  const activeConversations = new Map<string, string>()
  const lastSessionAgents = new Map<string, string>()
  const liveStreamSubagents = new Map<string, LiveStreamSubagent[]>()
  const lastAgentsFingerprint = new Map<string, string>()
  const providerID = Provider.ID.make(PROVIDER_ID)
  const disposers: Array<{ dispose?: () => Promise<void> | void }> = []
  const startupEnv = buildSanitizedEnv()
  const startupAgyBin = resolveAgyBinary(config.binaryPath, startupEnv)
  let currentCatalog = await discoverPlanCatalog(
    startupAgyBin,
    workspaceDir,
    startupEnv,
    config.defaultModel,
  )
  let lastCatalogRefreshAt = Date.now()
  let pendingRefreshPromise: Promise<AgyPlanCatalog> | null = null
  let emitUsageUpdate: ((catalog: AgyPlanCatalog) => void) | undefined
  let emitAgentsUpdate: ((sessionID: string) => void) | undefined

  const resolveSessionConvId = async (sessionID: string): Promise<string | undefined> => {
    if (!sessionID) return undefined
    const cached = activeConversations.get(sessionID)
    if (cached) return cached
    const storedConv = await ctx.storage.get(`agy:conv:${sessionID}`).catch(() => undefined)
    if (typeof storedConv === "string" && storedConv) {
      activeConversations.set(sessionID, storedConv)
      return storedConv
    }
    const toolConv = await ctx.storage.get(`agy:tool_conv:${sessionID}`).catch(() => undefined)
    if (typeof toolConv === "string" && toolConv) {
      return toolConv
    }
    return undefined
  }

  const buildAgentsJsonForSession = async (
    sessionID: string,
  ): Promise<{ readonly json: string; readonly fingerprint: string }> => {
    const convId = await resolveSessionConvId(sessionID)
    const dto = readAgyAgentsSnapshot({
      sessionID,
      conversationId: convId,
      streamSubagents: liveStreamSubagents.get(sessionID),
    })
    const fingerprint = JSON.stringify({
      conversationId: dto.conversationId ?? "",
      swarm: dto.swarm,
      subagents: dto.subagents,
    })
    return { json: JSON.stringify(dto), fingerprint }
  }

  const refreshPlanCatalog = async (force = false): Promise<AgyPlanCatalog> => {
    if (!force && Date.now() - lastCatalogRefreshAt < 45_000 && currentCatalog.quotaGroups.length > 0) {
      return currentCatalog
    }
    if (pendingRefreshPromise) {
      return pendingRefreshPromise
    }
    pendingRefreshPromise = (async () => {
      try {
        const env = buildSanitizedEnv()
        const agyBin = resolveAgyBinary(config.binaryPath, env)
        const next = await discoverPlanCatalog(agyBin, workspaceDir, env, config.defaultModel)
        if (next.quotaGroups.length > 0 || currentCatalog.quotaGroups.length === 0) {
          currentCatalog = next
          lastCatalogRefreshAt = Date.now()
          void ctx.model.reload().catch(() => {})
          emitUsageUpdate?.(currentCatalog)
        }
        return currentCatalog
      } finally {
        pendingRefreshPromise = null
      }
    })()
    return pendingRefreshPromise
  }

  if (ctx.rpc) {
    try {
      const registration = await ctx.rpc.register(AgyUsageRpc, {
        getUsage: async (input) => {
          const force = Boolean((input as { forceRefresh?: boolean } | undefined)?.forceRefresh)
          const catalog = await refreshPlanCatalog(force)
          return {
            json: JSON.stringify(buildUsageSnapshotDto(catalog)),
          }
        },
        getAgents: async (input) => {
          const sid = typeof (input as { sessionID?: unknown } | undefined)?.sessionID === "string"
            ? ((input as { sessionID: string }).sessionID ?? "").trim()
            : ""
          const { json, fingerprint } = await buildAgentsJsonForSession(sid)
          if (sid) lastAgentsFingerprint.set(sid, fingerprint)
          return { json }
        },
      })
      disposers.push(registration)
      emitUsageUpdate = (catalog) => {
        void registration.events
          .emit("updated", {
            json: JSON.stringify(buildUsageSnapshotDto(catalog)),
          })
          .catch(() => {})
      }
      emitAgentsUpdate = (sessionID) => {
        if (!sessionID) return
        void buildAgentsJsonForSession(sessionID)
          .then(({ json, fingerprint }) => {
            if (lastAgentsFingerprint.get(sessionID) === fingerprint) return
            lastAgentsFingerprint.set(sessionID, fingerprint)
            return registration.events.emit("agentsUpdated", { sessionID, json })
          })
          .catch(() => {})
      }
    } catch {
      // RPC registration is optional if the host does not support it
    }
  }

  await ctx.provider.transform((editor) => {
    const info = {
      ...Provider.Info.empty(providerID),
      name: "Antigravity",
      activation: "enabled" as const,
      package: "aisdk:agy-local",
    }

    const activeSpecs = currentCatalog.models.length > 0 ? currentCatalog.models : AGY_MODEL_SPECS
    const models = activeSpecs.map((spec) => {
      const quotaStatus = evaluateModelQuotaStatus(spec, currentCatalog.quotaGroups)
      return {
        ...Model.Info.default(providerID, Model.ID.make(spec.id)),
        name: quotaStatus.displayName,
        package: "aisdk:agy-local",
        capabilities: {
          tools: true,
          input: ["text", "image", "pdf"],
          output: ["text"],
        },
        variants: (spec.variants ?? []).map((variant) => ({
          id: Model.VariantID.make(variant),
          settings: { effort: variant },
        })),
        status: "active" as const,
        enabled: true,
        limit: {
          context: spec.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          output: spec.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        },
      }
    })

    editor.add({ info, models })
  })

  await ctx.session.hook(
    "title",
    (event) => {
      event.result = buildInstantTitle(event.messages)
    },
    { providerID: PROVIDER_ID },
  )

  const attachMetaHook =
    (kind: "primary" | "compaction" | "generate") =>
    (event: {
      readonly sessionID: string
      readonly agent: string
      readonly system: readonly unknown[]
      readonly options: Record<string, unknown>
    }) => {
      event.options.agyMeta = {
        sessionID: event.sessionID,
        agent: event.agent,
        kind,
        instructions: extractRelevantInstructions(event.system),
      } satisfies AgyMeta
    }

  await ctx.session.hook("context", attachMetaHook("primary"), { providerID: PROVIDER_ID })
  await ctx.session.hook("compaction", attachMetaHook("compaction"), { providerID: PROVIDER_ID })
  await ctx.session.hook("generate", attachMetaHook("generate"), { providerID: PROVIDER_ID })

  await ctx.aisdk.hook(
    "sdk",
    (input) => {
      input.sdk = { localAgyCli: true }
    },
    { providerID: PROVIDER_ID },
  )

  await ctx.aisdk.hook(
    "language",
    (input) => {
      const effort = typeof input.options?.effort === "string" ? input.options.effort : undefined
      const cliModel = resolveProviderCliModel(input.model.id, effort)

      const doStream = async (options: any) => {
        const meta: AgyMeta | undefined =
          options.providerOptions?.agy?.agyMeta ?? options.providerOptions?.agyMeta
        const isPrimary = meta?.kind === "primary" && Boolean(meta.sessionID)
        const sessionID = meta?.sessionID
        const agent = meta?.agent ?? "build"
        const readOnly = !isPrimary || config.readOnlyAgents.has(agent)

        let prevConvId: string | undefined
        let prevAgent: string | undefined
        if (isPrimary && sessionID) {
          prevConvId = activeConversations.get(sessionID)
          if (!prevConvId) {
            const storedConv = await ctx.storage.get(`agy:conv:${sessionID}`)
            if (typeof storedConv === "string" && storedConv) {
              prevConvId = storedConv
              activeConversations.set(sessionID, storedConv)
            }
          }
          prevAgent = lastSessionAgents.get(sessionID)
          if (!prevAgent) {
            const storedAgent = await ctx.storage.get(`agy:agent:${sessionID}`)
            if (typeof storedAgent === "string" && storedAgent) prevAgent = storedAgent
          }
        }

        const pendingUsage = isPrimary ? consumePendingUsageRequest(sessionID) : false
        const usageCmd =
          pendingUsage || (isPrimary ? detectUsageCommandInPrompt(options.prompt).matched : false)
        if (usageCmd) {
          const env = buildSanitizedEnv()
          const agyBin = resolveAgyBinary(config.binaryPath, env)
          const { report, catalog } = await buildAgyUsageReport({
            sessionID: sessionID ?? "",
            modelId: input.model.id,
            variant: effort,
            agyBin,
            workspaceDir,
            env,
            preferredDefaultModel: config.defaultModel,
          })
          currentCatalog = catalog
          lastCatalogRefreshAt = Date.now()
          void ctx.model.reload().catch(() => {})
          emitUsageUpdate?.(currentCatalog)

          const existingSummary = readAgyTranscriptSummary(prevConvId)
          const syncUsage = existingSummary?.latestStep
            ? toV3Usage({
                input_tokens: existingSummary.latestInputTokens,
                cache_read_tokens: existingSummary.latestCacheReadTokens,
                output_tokens: 1,
                thinking_tokens: 0,
              })
            : toV3Usage()
          return { stream: createInstantReportStream(report, syncUsage) }
        }

        const pendingCtx = isPrimary ? consumePendingContextRequest(sessionID) : { matched: false }
        const contextCmd = pendingCtx.matched
          ? pendingCtx
          : isPrimary
            ? detectContextCommandInPrompt(options.prompt)
            : { matched: false }
        if (contextCmd.matched) {
          const targetConvId = contextCmd.arg || prevConvId
          const env = buildSanitizedEnv()
          const agyBin = resolveAgyBinary(config.binaryPath, env)
          const spec = AGY_MODEL_MAP.get(input.model.id)
          const { report, latestStepUsage } = await buildAgyContextReport({
            sessionID: sessionID ?? "",
            providerId: PROVIDER_ID,
            modelId: input.model.id,
            variant: effort,
            cliModel,
            contextLimit: spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
            conversationId: targetConvId,
            agyBin,
            workspaceDir,
            env,
          })
          const syncUsage = latestStepUsage
            ? toV3Usage({
                input_tokens: latestStepUsage.inputTokens,
                cache_read_tokens: latestStepUsage.cacheReadTokens,
                output_tokens: 1,
                thinking_tokens: 0,
              })
            : toV3Usage()
          return { stream: createInstantReportStream(report, syncUsage) }
        }

        const pendingSwarm = isPrimary ? consumePendingSwarmRequest(sessionID) : false
        const swarmCmd = isPrimary ? detectSwarmCommandInPrompt(options.prompt) : { matched: false }
        if ((pendingSwarm || swarmCmd.matched) && !swarmCmd.task && swarmCmd.matched) {
          return {
            stream: createInstantReportStream(
              "Provide a task after `/swarm <task>` to start an Antigravity swarm (for example: `/swarm Audit src/ and add unit tests`).",
              toV3Usage(),
            ),
          }
        }
        if ((pendingSwarm || swarmCmd.matched) && !config.allowSwarm) {
          return {
            stream: createInstantReportStream(
              'Antigravity swarm is disabled by plugin configuration (`"allowSwarm": false`). Set `"allowSwarm": true` in `opencode.jsonc` to enable `/swarm`.',
              toV3Usage(),
            ),
          }
        }

        const promptText = buildProviderPrompt({
          prompt: options.prompt,
          resumingConversation: Boolean(prevConvId),
          meta,
          agentChanged: Boolean(prevAgent && prevAgent !== agent),
          readOnly,
        })

        if (!promptText) {
          return { stream: createEmptyPromptStream(cliModel) }
        }

        if (isPrimary && sessionID) {
          lastSessionAgents.set(sessionID, agent)
          void ctx.storage.set(`agy:agent:${sessionID}`, agent).catch(() => {})
        }

        const isSwarmTurn =
          config.allowSwarm &&
          !readOnly &&
          (pendingSwarm || swarmCmd.matched || hasActiveAgySwarm(prevConvId))
        const effectiveTimeoutSeconds = isSwarmTurn ? config.swarmTimeoutSeconds : config.timeoutSeconds
        const enableSlashCommands = config.enableSlashCommands || isSwarmTurn

        const env = buildSanitizedEnv()
        const agyBin = resolveAgyBinary(config.binaryPath, env)
        const args = buildStreamArgs({
          promptText,
          cliModel,
          timeoutSeconds: effectiveTimeoutSeconds,
          readOnly,
          mode: config.mode,
          allowAllTools: config.allowAllTools,
          enableSlashCommands,
          prevConvId,
          responseSchema: options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined,
        })

        const stream = createStreamingAgyStream({
          agyBin,
          args,
          workspaceDir,
          env,
          timeoutSeconds: effectiveTimeoutSeconds,
          abortSignal: options.abortSignal,
          onConversationId: (convId) => {
            if (!convId || !isPrimary || !sessionID) return
            const changed = activeConversations.get(sessionID) !== convId
            activeConversations.set(sessionID, convId)
            void ctx.storage.set(`agy:conv:${sessionID}`, convId).catch(() => {})
            if (changed) emitAgentsUpdate?.(sessionID)
          },
          onSubagentStep: (stepIndex, state, subagents) => {
            if (!isPrimary || !sessionID) return
            const prev = liveStreamSubagents.get(sessionID) ?? []
            const filtered = prev.filter((item) => item.spawnStepIndex !== stepIndex)
            if (state !== "DONE") {
              for (const raw of subagents) {
                filtered.push({
                  conversationId: typeof raw.conversation_id === "string" ? raw.conversation_id : undefined,
                  typeName: typeof raw.type_name === "string" ? raw.type_name : "subagent",
                  role: typeof raw.role === "string" ? raw.role : "Subagent",
                  initialPrompt: typeof raw.initial_prompt === "string" ? raw.initial_prompt : undefined,
                  workspaceUris: Array.isArray(raw.workspace_uris)
                    ? raw.workspace_uris.filter((u): u is string => typeof u === "string")
                    : undefined,
                  spawnStepIndex: stepIndex,
                })
              }
            }
            liveStreamSubagents.set(sessionID, filtered)
            emitAgentsUpdate?.(sessionID)
          },
          onSwarmOrAgentActivity: () => {
            if (!isPrimary || !sessionID) return
            emitAgentsUpdate?.(sessionID)
          },
          onTurnComplete: () => {
            if (!isPrimary) return
            if (sessionID) {
              liveStreamSubagents.delete(sessionID)
              emitAgentsUpdate?.(sessionID)
            }
            void refreshPlanCatalog(true).catch(() => {})
          },
        })

        return { stream }
      }

      input.language = {
        specificationVersion: "v3",
        provider: PROVIDER_ID,
        modelId: input.model.id,
        supportedUrls: {},
        doStream,
        async doGenerate(options) {
          const { stream } = await doStream(options)
          const reader = stream.getReader()
          const textParts = new Map<string, string>()
          const orderedIds: string[] = []
          let finishReason: { unified: any; raw: string | undefined } = { unified: "stop", raw: "SUCCESS" }
          let usage = toV3Usage()
          let firstError: unknown

          while (true) {
            const { value, done } = await reader.read()
            if (done) break
            if (!value) continue
            if (value.type === "text-start") {
              orderedIds.push(value.id)
              textParts.set(value.id, "")
            } else if (value.type === "text-delta") {
              textParts.set(value.id, (textParts.get(value.id) ?? "") + value.delta)
            } else if (value.type === "finish") {
              finishReason = value.finishReason
              usage = value.usage
            } else if (value.type === "error" && !firstError) {
              firstError = value.error
            }
          }

          if (firstError && textParts.size === 0) {
            throw firstError instanceof Error ? firstError : new Error(String(firstError))
          }

          return {
            content: orderedIds
              .map((id) => ({ type: "text" as const, text: textParts.get(id) ?? "" }))
              .filter((p) => p.text.length > 0),
            finishReason,
            usage,
            warnings: [],
          }
        },
      }
    },
    { providerID: PROVIDER_ID },
  )

  return async () => {
    for (const d of disposers) {
      try {
        await d.dispose?.()
      } catch {
        // ignore
      }
    }
  }
}
