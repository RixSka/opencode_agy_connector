import { Model, Provider, type Plugin } from "@opencode/plugin"
import { buildSanitizedEnv, resolveAgyBinary } from "./env.ts"
import { buildFailureMessage, inspectControlLine, toV3Usage } from "./output.ts"
import { buildInstantTitle, buildProviderPrompt, extractRelevantInstructions } from "./prompt.ts"
import { spawnAgyProcess } from "./runner.ts"
import {
  AGY_MODEL_SPECS,
  PROVIDER_ID,
  resolveProviderCliModel,
  type AgyConnectorConfig,
  type AgyErrorPayload,
  type AgyJsonResult,
  type AgyMeta,
} from "./types.ts"

interface StreamTurnParams {
  readonly agyBin: string
  readonly args: readonly string[]
  readonly workspaceDir: string
  readonly env: Record<string, string>
  readonly timeoutSeconds: number
  readonly abortSignal?: AbortSignal
  readonly onConversationId: (convId?: string) => void
}

function buildStreamArgs(params: {
  readonly promptText: string
  readonly cliModel: string
  readonly timeoutSeconds: number
  readonly readOnly: boolean
  readonly allowAllTools: boolean
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
    "--disable-slash-commands",
    "--print-timeout",
    `${params.timeoutSeconds}s`,
  ]

  if (!params.readOnly) {
    args.push("--mode", "accept-edits")
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
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "stream-start", warnings: [] })
      controller.enqueue({ type: "text-start", id: "t_empty" })
      controller.enqueue({ type: "text-delta", id: "t_empty", delta: msg })
      controller.enqueue({ type: "text-end", id: "t_empty" })
      controller.enqueue({
        type: "finish",
        finishReason: { unified: "stop", raw: "EMPTY_PROMPT" },
        usage: toV3Usage(),
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
      const { child, cleanup } = spawnAgyProcess(
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

      let stdoutBuf = ""
      const rawStdoutLines: string[] = []
      const rawStderrLines: string[] = []
      let activeTextId: string | undefined
      let textCounter = 0
      let emittedAnyText = false
      let resultPayload: AgyJsonResult | undefined
      let agyError: AgyErrorPayload | undefined
      let permissionBlocked: string | undefined
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

          if (su.step_type === "tool") {
            const callId = `agy_step_${String(su.step_index)}`
            const toolInfo = (su.tool_info ?? {}) as Record<string, any>
            const toolName = String(su.tool_name || toolInfo.name || "agy_tool")
            const toolParams = toolInfo.parameters ?? {}
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

            if (su.state === "DONE" && !endedTools.has(callId)) {
              endedTools.add(callId)
              const output = toolInfo.output
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
          if (resultPayload.usage) {
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
          return
        }

        controller.enqueue({
          type: "finish",
          finishReason: { unified: "stop", raw: resultPayload?.status ?? "SUCCESS" },
          usage: finalUsage,
        })
        controller.close()
      })
    },
  })
}

/** Register the native `agy/*` AI SDK model provider and session lifecycle hooks. */
export async function registerAgyProvider(
  ctx: Plugin.Context,
  config: AgyConnectorConfig,
): Promise<void> {
  const workspaceDir = ctx.location.directory
  const activeConversations = new Map<string, string>()
  const lastSessionAgents = new Map<string, string>()
  const providerID = Provider.ID.make(PROVIDER_ID)

  await ctx.provider.transform((editor) => {
    const info = {
      ...Provider.Info.empty(providerID),
      name: "Antigravity",
      activation: "enabled" as const,
      package: "aisdk:agy-local",
    }

    const models = AGY_MODEL_SPECS.map((spec) => ({
      ...Model.Info.default(providerID, Model.ID.make(spec.id)),
      name: spec.name,
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
    }))

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

        const env = buildSanitizedEnv()
        const agyBin = resolveAgyBinary(config.binaryPath, env)
        const args = buildStreamArgs({
          promptText,
          cliModel,
          timeoutSeconds: config.timeoutSeconds,
          readOnly,
          allowAllTools: config.allowAllTools,
          prevConvId,
          responseSchema: options.responseFormat?.type === "json" ? options.responseFormat.schema : undefined,
        })

        const stream = createStreamingAgyStream({
          agyBin,
          args,
          workspaceDir,
          env,
          timeoutSeconds: config.timeoutSeconds,
          abortSignal: options.abortSignal,
          onConversationId: (convId) => {
            if (!convId || !isPrimary || !sessionID) return
            activeConversations.set(sessionID, convId)
            void ctx.storage.set(`agy:conv:${sessionID}`, convId).catch(() => {})
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
}
