import { existsSync, readFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { runAgyBuffered } from "./runner.ts"
import {
  AGY_MODEL_MAP,
  AGY_MODEL_SPECS,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  PROVIDER_ID,
  resolveProviderCliModel,
  type AgyModelSpec,
} from "./types.ts"

export interface AgyPlannerStepSummary {
  readonly stepIndex: number
  readonly model?: string
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly realContextTokens: number
  readonly outputTokens: number
  readonly toolNames: readonly string[]
  readonly createdAt?: string
}

export interface AgyContextBreakdown {
  readonly systemTokens: number
  readonly userTokens: number
  readonly toolTokens: number
  readonly assistantTokens: number
}

export interface AgyTranscriptSummary {
  readonly conversationId: string
  readonly transcriptPath: string
  readonly totalSteps: number
  readonly userStepCount: number
  readonly plannerStepCount: number
  readonly toolResultStepCount: number
  readonly compactionCheckpointCount: number
  readonly totalToolCalls: number
  readonly toolCounts: ReadonlyMap<string, number>
  readonly firstStep?: AgyPlannerStepSummary
  readonly latestStep?: AgyPlannerStepSummary
  readonly plannerSteps: readonly AgyPlannerStepSummary[]
  readonly realContextTokens: number
  readonly latestInputTokens: number
  readonly latestCacheReadTokens: number
  readonly cumulativeOutputTokens: number
  readonly breakdown: AgyContextBreakdown
}

export interface AgyQuotaBucket {
  readonly id: string
  readonly name: string
  readonly window?: string
  readonly remainingFraction: number
  readonly resetTime?: string
}

export interface AgyQuotaGroup {
  readonly name: string
  readonly description?: string
  readonly buckets: readonly AgyQuotaBucket[]
}

export interface BuildAgyContextReportParams {
  readonly sessionID: string
  readonly providerId?: string
  readonly modelId: string
  readonly variant?: string
  readonly cliModel?: string
  readonly contextLimit?: number
  readonly conversationId?: string
  readonly agyBin?: string
  readonly workspaceDir?: string
  readonly env?: Record<string, string>
  readonly homeDir?: string
  readonly quotaGroups?: readonly AgyQuotaGroup[]
}

const SAFE_CONV_ID = /^[a-zA-Z0-9_-]{4,128}$/

const pendingContextRequests = new Map<string, { readonly arg?: string }>()
const pendingUsageRequests = new Set<string>()

/** Record an explicit `/context` invocation for a session before triggering `session.prompt`. */
export function enqueuePendingContextRequest(sessionID: string, arg?: string): void {
  if (!sessionID) return
  pendingContextRequests.set(sessionID, { ...(arg ? { arg } : {}) })
}

/** Consume a pending `/context` request for a session if one was queued by the command handler. */
export function consumePendingContextRequest(
  sessionID: string | undefined,
): { readonly matched: boolean; readonly arg?: string } {
  if (!sessionID) return { matched: false }
  const entry = pendingContextRequests.get(sessionID)
  if (!entry) return { matched: false }
  pendingContextRequests.delete(sessionID)
  return { matched: true, ...(entry.arg ? { arg: entry.arg } : {}) }
}

/** Record an explicit `/usage` invocation for an `agy/*` session before triggering `session.prompt`. */
export function enqueuePendingUsageRequest(sessionID: string): void {
  if (!sessionID) return
  pendingUsageRequests.add(sessionID)
}

/** Consume a pending `/usage` request for a session if one was queued by the command handler. */
export function consumePendingUsageRequest(sessionID: string | undefined): boolean {
  if (!sessionID || !pendingUsageRequests.has(sessionID)) return false
  pendingUsageRequests.delete(sessionID)
  return true
}

function extractUserRequestBody(rawContent: string): string {
  const withoutInstructions = rawContent
    .replace(/<workspace_and_role_instructions>[\s\S]*?<\/workspace_and_role_instructions>/gi, "")
    .replace(/<system_instructions>[\s\S]*?<\/system_instructions>/gi, "")
    .replace(/<read_only_constraint>[\s\S]*?<\/read_only_constraint>/gi, "")
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")

  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(withoutInstructions)
  return (reqMatch?.[1] ?? withoutInstructions).trim()
}

function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2).replace(/\.00$/, "")}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`
  }
  return `${Math.round(tokens)}`
}

function createBar(value: number, maxValue: number, width: number, fillChar = "█", emptyChar = "░"): string {
  if (maxValue <= 0 || width <= 0) return emptyChar.repeat(Math.max(0, width))
  const ratio = Math.max(0, Math.min(1, value / maxValue))
  const filled = Math.round(ratio * width)
  return fillChar.repeat(filled) + emptyChar.repeat(Math.max(0, width - filled))
}

/** Resolve the transcript path for an Antigravity CLI conversation ID. */
export function getAgyTranscriptPath(conversationId: string, homeDir: string = os.homedir()): string {
  return path.join(
    homeDir,
    ".gemini",
    "antigravity-cli",
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  )
}

/** Parse `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` into real context metrics. */
export function readAgyTranscriptSummary(
  conversationId: string | undefined,
  homeDir: string = os.homedir(),
): AgyTranscriptSummary | undefined {
  if (!conversationId || !SAFE_CONV_ID.test(conversationId.trim())) return undefined
  const cid = conversationId.trim()
  const transcriptPath = getAgyTranscriptPath(cid, homeDir)
  if (!existsSync(transcriptPath)) return undefined

  let raw = ""
  try {
    raw = readFileSync(transcriptPath, "utf8")
  } catch {
    return undefined
  }

  const plannerSteps: AgyPlannerStepSummary[] = []
  const toolCounts = new Map<string, number>()
  let totalSteps = 0
  let userStepCount = 0
  let toolResultStepCount = 0
  let compactionCheckpointCount = 0
  let totalToolCalls = 0
  let cumulativeOutputTokens = 0
  let firstUserChars = 0
  let foundFirstUser = false
  let totalUserChars = 0
  let totalToolChars = 0

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue

    let step: Record<string, any>
    try {
      step = JSON.parse(line) as Record<string, any>
    } catch {
      continue
    }

    totalSteps += 1
    const stepType = String(step.type ?? "")
    const content = typeof step.content === "string" ? step.content : ""

    if (stepType === "USER_INPUT") {
      userStepCount += 1
      if (content.includes("<conversation-checkpoint>")) {
        compactionCheckpointCount += 1
      }
      const cleanBody = extractUserRequestBody(content)
      if (!foundFirstUser) {
        foundFirstUser = true
        firstUserChars = cleanBody.length
      }
      totalUserChars += cleanBody.length
      continue
    }

    if (stepType === "GENERIC") {
      toolResultStepCount += 1
      totalToolChars += content.length
      continue
    }

    if (stepType === "PLANNER_RESPONSE") {
      const inputTokens = typeof step.input_tokens === "number" ? step.input_tokens : 0
      const cacheReadTokens = typeof step.cache_read_tokens === "number" ? step.cache_read_tokens : 0
      const outputTokens = typeof step.output_tokens === "number" ? step.output_tokens : 0
      const rawCalls = Array.isArray(step.tool_calls) ? step.tool_calls : []
      const toolNames: string[] = []

      for (const tc of rawCalls) {
        if (tc && typeof tc === "object") {
          const name = typeof tc.name === "string" && tc.name ? tc.name : "tool"
          toolNames.push(name)
          toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1)
          totalToolChars += JSON.stringify(tc.args ?? {}).length
        }
      }

      totalToolCalls += toolNames.length
      cumulativeOutputTokens += outputTokens

      plannerSteps.push({
        stepIndex: typeof step.step_index === "number" ? step.step_index : plannerSteps.length,
        model: typeof step.model === "string" ? step.model : undefined,
        inputTokens,
        cacheReadTokens,
        realContextTokens: inputTokens + cacheReadTokens,
        outputTokens,
        toolNames,
        createdAt: typeof step.created_at === "string" ? step.created_at : undefined,
      })
    }
  }

  const firstStep = plannerSteps[0]
  const latestStep = plannerSteps.at(-1)
  const realContextTokens = latestStep?.realContextTokens ?? 0
  const latestInputTokens = latestStep?.inputTokens ?? 0
  const latestCacheReadTokens = latestStep?.cacheReadTokens ?? 0

  const firstStepCtx = firstStep?.realContextTokens ?? 0
  const firstUserTokens = Math.min(firstStepCtx, estimateTokens("x".repeat(firstUserChars)))
  const baseSystemEst = Math.max(0, firstStepCtx - firstUserTokens)
  const rawUserEst = Math.max(firstUserTokens, Math.ceil(totalUserChars / 4))
  const rawToolEst = Math.ceil(totalToolChars / 4)

  let systemTokens = 0
  let userTokens = 0
  let toolTokens = 0
  let assistantTokens = 0

  if (realContextTokens > 0) {
    if (baseSystemEst + rawUserEst + rawToolEst <= realContextTokens) {
      systemTokens = baseSystemEst
      userTokens = rawUserEst
      toolTokens = rawToolEst
      assistantTokens = Math.max(0, realContextTokens - systemTokens - userTokens - toolTokens)
    } else {
      systemTokens = Math.min(baseSystemEst, Math.round(realContextTokens * 0.45))
      const remaining = Math.max(0, realContextTokens - systemTokens)
      const dynamicTotal = Math.max(1, rawUserEst + rawToolEst + cumulativeOutputTokens)
      userTokens = Math.round((rawUserEst / dynamicTotal) * remaining)
      toolTokens = Math.round((rawToolEst / dynamicTotal) * remaining)
      assistantTokens = Math.max(0, remaining - userTokens - toolTokens)
    }
  }

  return {
    conversationId: cid,
    transcriptPath,
    totalSteps,
    userStepCount,
    plannerStepCount: plannerSteps.length,
    toolResultStepCount,
    compactionCheckpointCount,
    totalToolCalls,
    toolCounts,
    firstStep,
    latestStep,
    plannerSteps,
    realContextTokens,
    latestInputTokens,
    latestCacheReadTokens,
    cumulativeOutputTokens,
    breakdown: {
      systemTokens,
      userTokens,
      toolTokens,
      assistantTokens,
    },
  }
}

/** Query `agy -p "/usage" --output-format json` (zero quota cost) for live quota buckets. */
export async function fetchAgyQuotaGroups(
  agyBin: string,
  workspaceDir: string,
  env: Record<string, string>,
): Promise<readonly AgyQuotaGroup[]> {
  try {
    const res = await runAgyBuffered(agyBin, ["-p", "/usage", "--output-format", "json"], workspaceDir, env, 5)
    for (const rawLine of res.stdout.split("\n")) {
      const line = rawLine.trim()
      if (!line.startsWith("{")) continue
      const parsed = JSON.parse(line) as Record<string, any>
      const groups = parsed?.command?.data?.groups
      if (!Array.isArray(groups)) continue
      return groups.map((g: Record<string, any>) => ({
        name: String(g.name ?? "Models"),
        description: typeof g.description === "string" ? g.description : undefined,
        buckets: Array.isArray(g.buckets)
          ? g.buckets.map((b: Record<string, any>) => ({
              id: String(b.id ?? ""),
              name: String(b.name ?? ""),
              window: typeof b.window === "string" ? b.window : undefined,
              remainingFraction: typeof b.remaining_fraction === "number" ? b.remaining_fraction : 0,
              resetTime: typeof b.reset_time === "string" ? b.reset_time : undefined,
            }))
          : [],
      }))
    }
  } catch {
    // Return empty array if CLI is unreachable.
  }
  return []
}

/** Locate the most recent non-empty Antigravity conversation matching `workspaceDir` (or overall fallback). */
export function resolveLatestWorkspaceConversation(
  workspaceDir?: string,
  homeDir: string = os.homedir(),
): { readonly conversationId: string; readonly source: "workspace" | "recent" } | undefined {
  const metaPath = path.join(homeDir, ".gemini", "antigravity-cli", "cache", "conversation_metadata.json")
  if (!existsSync(metaPath)) return undefined

  let rawMap: Record<string, any> | undefined
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, any>
    if (parsed && typeof parsed.conversations === "object" && parsed.conversations !== null) {
      rawMap = parsed.conversations as Record<string, any>
    }
  } catch {
    return undefined
  }
  if (!rawMap) return undefined

  const targetUri = workspaceDir ? pathToFileURL(path.resolve(workspaceDir)).href.replace(/\/$/, "") : undefined

  const entries = Object.entries(rawMap)
    .filter(([cid]) => SAFE_CONV_ID.test(cid))
    .sort((a, b) => {
      const ta = String(a[1]?.last_modified_time ?? a[1]?.summary?.UpdatedAt ?? "")
      const tb = String(b[1]?.last_modified_time ?? b[1]?.summary?.UpdatedAt ?? "")
      return tb.localeCompare(ta)
    })

  if (targetUri) {
    for (const [cid, item] of entries) {
      const uris: unknown[] = Array.isArray(item?.summary?.WorkspaceURIs) ? item.summary.WorkspaceURIs : []
      const matches = uris.some((u) => {
        if (typeof u !== "string") return false
        const norm = u.replace(/\/$/, "")
        return norm === targetUri || norm.startsWith(`${targetUri}/`)
      })
      if (!matches) continue
      const summary = readAgyTranscriptSummary(cid, homeDir)
      if (summary?.latestStep) {
        return { conversationId: cid, source: "workspace" }
      }
    }
  }

  for (const [cid] of entries.slice(0, 25)) {
    const summary = readAgyTranscriptSummary(cid, homeDir)
    if (summary?.latestStep) {
      return { conversationId: cid, source: "recent" }
    }
  }

  return undefined
}

function summarizeStepTools(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return "—"
  const counts = new Map<string, number>()
  for (const name of toolNames) {
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return Array.from(counts.entries())
    .map(([name, count]) => (count > 1 ? `\`${name}\` ×${count}` : `\`${name}\``))
    .join(", ")
}

function formatResetTime(isoReset?: string): string {
  if (!isoReset) return "—"
  const d = new Date(isoReset)
  if (Number.isNaN(d.getTime())) return `\`${isoReset}\``
  const diffMs = d.getTime() - Date.now()
  let rel = ""
  if (diffMs > 0) {
    const totalMins = Math.max(1, Math.round(diffMs / 60_000))
    const days = Math.floor(totalMins / (60 * 24))
    const hours = Math.floor((totalMins % (60 * 24)) / 60)
    const mins = totalMins % 60
    if (days > 0) rel = ` *(in ${days}d ${hours}h)*`
    else if (hours > 0) rel = ` *(in ${hours}h ${mins}m)*`
    else rel = ` *(in ${mins}m)*`
  }
  const pad = (n: number) => String(n).padStart(2, "0")
  const localStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `\`${localStr}\`${rel}`
}

/** Build the formatted `/context` Markdown inspection report and latest step usage. */
export async function buildAgyContextReport(params: BuildAgyContextReportParams): Promise<{
  readonly report: string
  readonly resolvedConversationId?: string
  readonly latestStepUsage?: {
    readonly inputTokens: number
    readonly cacheReadTokens: number
    readonly realContextTokens: number
  }
}> {
  const providerId = params.providerId ?? PROVIDER_ID
  const spec = AGY_MODEL_MAP.get(params.modelId)
  const variant = params.variant ?? spec?.defaultVariant
  const cliModel = params.cliModel ?? resolveProviderCliModel(params.modelId, variant)
  const contextLimit = params.contextLimit ?? spec?.contextWindow ?? DEFAULT_CONTEXT_WINDOW
  const modelLabel = `${providerId}/${params.modelId}${variant ? `#${variant}` : ""}`

  let convSource: "session" | "workspace" | "recent" = "session"
  let summary = readAgyTranscriptSummary(params.conversationId, params.homeDir)
  if (!summary?.latestStep && !params.conversationId) {
    const fallback = resolveLatestWorkspaceConversation(params.workspaceDir, params.homeDir)
    if (fallback) {
      convSource = fallback.source
      summary = readAgyTranscriptSummary(fallback.conversationId, params.homeDir)
    }
  }

  const quotaGroups =
    params.quotaGroups ??
    (params.agyBin && params.workspaceDir && params.env
      ? await fetchAgyQuotaGroups(params.agyBin, params.workspaceDir, params.env)
      : [])

  const lines: string[] = [
    "```text",
    "╭────────────────────────────────────────────────────────────╮",
    "│             Antigravity (agy) Context Analysis             │",
    "╰────────────────────────────────────────────────────────────╯",
  ]

  if (summary && summary.latestStep) {
    const pct = contextLimit > 0 ? ((summary.realContextTokens / contextLimit) * 100).toFixed(1) : "0.0"
    const cacheHitPct =
      summary.realContextTokens > 0
        ? ((summary.latestCacheReadTokens / summary.realContextTokens) * 100).toFixed(1)
        : "0.0"
    const winBar = createBar(summary.realContextTokens, contextLimit, 30, "█", "░")

    lines.push("")
    lines.push(
      `Context Window: ${formatCompactTokens(summary.realContextTokens)} / ${formatCompactTokens(contextLimit)} (${pct}%) │${winBar}│`,
    )
    lines.push("────────────────────────────────────────────────────────────")

    const categories = [
      { label: "System & agy Tools", value: summary.breakdown.systemTokens, char: "█" },
      { label: "User Prompts", value: summary.breakdown.userTokens, char: "▓" },
      { label: `Tool Calls (${summary.totalToolCalls})`, value: summary.breakdown.toolTokens, char: "▒" },
      { label: "Assistant & History", value: summary.breakdown.assistantTokens, char: "░" },
    ]
    const maxLabelLen = Math.max(...categories.map((c) => c.label.length), 19)

    for (const cat of categories) {
      const catBar = createBar(cat.value, summary.realContextTokens, 26, cat.char, " ")
      const catPct =
        summary.realContextTokens > 0 ? ((cat.value / summary.realContextTokens) * 100).toFixed(1) : "0.0"
      const left = `${cat.label.padEnd(maxLabelLen)} ${catPct.padStart(5)}% `
      const right = `${formatNumber(cat.value).padStart(9)} tok`
      lines.push(`${left}│${catBar}│ ${right}`)
    }

    lines.push("────────────────────────────────────────────────────────────")
    lines.push(
      `Active Context:  ${formatNumber(summary.realContextTokens)} tokens (${formatNumber(summary.latestInputTokens)} uncached + ${formatNumber(summary.latestCacheReadTokens)} cached, ${cacheHitPct}% hit)`,
    )
    lines.push(
      `Session Totals:  ${summary.plannerStepCount} model calls · ${summary.totalToolCalls} tool calls · ${formatNumber(summary.cumulativeOutputTokens)} output tokens`,
    )
    lines.push("```")

    const sourceNote =
      convSource === "session"
        ? "bound to current session"
        : convSource === "workspace"
          ? "latest workspace conversation"
          : "latest Antigravity conversation"

    lines.push("")
    lines.push(`- **Active Model:** \`${modelLabel}\` (CLI: \`${summary.latestStep.model ?? cliModel}\`)`)
    lines.push(`- **OpenCode Session:** \`${params.sessionID || "current"}\``)
    lines.push(`- **Antigravity Conversation:** \`${summary.conversationId}\` *(${sourceNote})*`)

    const recentSteps = summary.plannerSteps.slice(-8)
    lines.push("")
    lines.push(`### Step-by-Step Context Trajectory (${recentSteps.length} of ${summary.plannerStepCount} calls)`)
    lines.push("")
    lines.push("| Step | Uncached Input | Cache Read | Real Context | Output | Tools |")
    lines.push("| :--- | ---: | ---: | ---: | ---: | :--- |")
    for (const st of recentSteps) {
      lines.push(
        `| \`#${st.stepIndex}\` | ${formatNumber(st.inputTokens)} | ${formatNumber(st.cacheReadTokens)} | **${formatNumber(st.realContextTokens)}** | ${formatNumber(st.outputTokens)} | ${summarizeStepTools(st.toolNames)} |`,
      )
    }

    lines.push("")
    lines.push("### Direct Context Access")
    lines.push(`- **Interactive \`agy\` \`/context\` TUI:** \`agy --conversation ${summary.conversationId}\` *(then run \`/context\`)*`)
    lines.push(`- **Raw Step Transcript:** [transcript.jsonl](file://${summary.transcriptPath})`)
  } else {
    lines.push("")
    lines.push(`Model:          ${modelLabel} (${cliModel})`)
    lines.push(`Context Limit:  ${formatNumber(contextLimit)} tokens`)
    lines.push(`Status:         No Antigravity turn recorded in this session yet.`)
    lines.push("```")
    lines.push("")
    lines.push(
      `Send a prompt on \`${modelLabel}\` (or run \`/agy <task>\`) to initialize an Antigravity conversation, or pass an existing ID via \`/context <conversation_id>\`.`,
    )
  }

  if (quotaGroups.length > 0) {
    lines.push("")
    lines.push("### Antigravity Quota (`/usage`)")
    lines.push("")
    lines.push("| Model Group | Window | Remaining | Reset (Local) |")
    lines.push("| :--- | :--- | :--- | :--- |")
    for (const group of quotaGroups) {
      for (const bucket of group.buckets) {
        const remPct = Math.round(bucket.remainingFraction * 100)
        const bar = createBar(remPct, 100, 10, "█", "░")
        const reset = formatResetTime(bucket.resetTime)
        lines.push(`| **${group.name}** | ${bucket.window ?? bucket.name} | \`${bar}\` **${remPct}%** | ${reset} |`)
      }
    }
  }

  return {
    report: lines.join("\n"),
    resolvedConversationId: summary?.conversationId,
    latestStepUsage: summary?.latestStep
      ? {
          inputTokens: summary.latestInputTokens,
          cacheReadTokens: summary.latestCacheReadTokens,
          realContextTokens: summary.realContextTokens,
        }
      : undefined,
  }
}

const VARIANT_ORDER: readonly string[] = ["low", "medium", "high", "xhigh", "max"]

/** Parse tab-separated `agy models` output into grouped OpenCode `AgyModelSpec` definitions. */
export function parseAgyModelsOutput(rawStdout: string): readonly AgyModelSpec[] {
  const rawEntries: Array<{ readonly cliId: string; readonly label: string }> = []
  for (const rawLine of rawStdout.split("\n")) {
    const cleaned = rawLine.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "").trim()
    if (!cleaned || cleaned.includes("Fetching available models")) continue
    const tabIdx = cleaned.indexOf("\t")
    if (tabIdx <= 0) continue
    const cliId = cleaned.slice(0, tabIdx).trim()
    const label = cleaned.slice(tabIdx + 1).trim()
    if (cliId && label) {
      rawEntries.push({ cliId, label })
    }
  }

  if (rawEntries.length === 0) return AGY_MODEL_SPECS

  const familyVariants = new Map<string, { baseLabel: string; variants: Set<string>; singleCliId: string; singleLabel: string }>()

  for (const { cliId, label } of rawEntries) {
    const knownExact = AGY_MODEL_MAP.get(cliId)
    if (knownExact && (!knownExact.variants || knownExact.variants.length === 0)) {
      familyVariants.set(cliId, {
        baseLabel: knownExact.name,
        variants: new Set(),
        singleCliId: cliId,
        singleLabel: knownExact.name,
      })
      continue
    }

    const match = /^(.+)-(low|medium|high|xhigh|max)$/i.exec(cliId)
    if (match) {
      const baseId = match[1]!
      const variant = match[2]!.toLowerCase()
      const strippedLabel = label.replace(/\s*\((?:Low|Medium|High|XHigh|Max)\)\s*$/i, "").trim()
      const existing = familyVariants.get(baseId)
      if (existing) {
        existing.variants.add(variant)
      } else {
        familyVariants.set(baseId, {
          baseLabel: strippedLabel || baseId,
          variants: new Set([variant]),
          singleCliId: cliId,
          singleLabel: label,
        })
      }
    } else {
      familyVariants.set(cliId, {
        baseLabel: label,
        variants: new Set(),
        singleCliId: cliId,
        singleLabel: label,
      })
    }
  }

  const specs: AgyModelSpec[] = []
  for (const [baseId, info] of familyVariants.entries()) {
    const known = AGY_MODEL_MAP.get(baseId) ?? AGY_MODEL_MAP.get(info.singleCliId)
    if (info.variants.size <= 1 && !AGY_MODEL_MAP.has(baseId) && AGY_MODEL_MAP.has(info.singleCliId)) {
      specs.push(AGY_MODEL_MAP.get(info.singleCliId)!)
      continue
    }

    const sortedVariants = Array.from(info.variants).sort(
      (a, b) => VARIANT_ORDER.indexOf(a) - VARIANT_ORDER.indexOf(b),
    )

    const defaultVariant =
      known?.defaultVariant && sortedVariants.includes(known.defaultVariant)
        ? known.defaultVariant
        : sortedVariants.includes("medium")
          ? "medium"
          : sortedVariants.includes("high")
            ? "high"
            : sortedVariants[0]

    const displayName = known?.name ?? (info.baseLabel.includes("Antigravity") ? info.baseLabel : `${info.baseLabel} (Antigravity)`)
    const isSmallCtx = (known?.id ?? baseId).startsWith("gpt-oss")

    specs.push({
      id: known && (!known.variants || known.variants.length === 0) ? known.id : baseId,
      name: displayName,
      ...(sortedVariants.length > 0 ? { variants: sortedVariants, defaultVariant } : {}),
      contextWindow: known?.contextWindow ?? (isSmallCtx ? 128_000 : DEFAULT_CONTEXT_WINDOW),
      maxOutputTokens: known?.maxOutputTokens ?? (isSmallCtx ? 32_000 : DEFAULT_MAX_OUTPUT_TOKENS),
    })
  }

  // Sort so known canonical order comes first, followed by any new plan models
  const canonicalOrder = AGY_MODEL_SPECS.map((s) => s.id)
  specs.sort((a, b) => {
    const ia = canonicalOrder.indexOf(a.id)
    const ib = canonicalOrder.indexOf(b.id)
    if (ia !== -1 && ib !== -1) return ia - ib
    if (ia !== -1) return -1
    if (ib !== -1) return 1
    return a.id.localeCompare(b.id)
  })

  return specs.length > 0 ? specs : AGY_MODEL_SPECS
}

/** Match an OpenCode `agy/*` model ID to its corresponding `/usage` quota group. */
export function matchQuotaGroupForModel(
  modelId: string,
  quotaGroups: readonly AgyQuotaGroup[],
): AgyQuotaGroup | undefined {
  const lower = modelId.toLowerCase()
  if (lower.includes("argon") || lower.includes("orchestrator")) {
    const argonGroup = quotaGroups.find((g) => g.name.toLowerCase().includes("argon"))
    if (argonGroup) return argonGroup
  }
  if (lower.startsWith("gemini-")) {
    return quotaGroups.find((g) => g.name.toLowerCase().includes("gemini"))
  }
  if (lower.startsWith("claude-") || lower.startsWith("gpt-")) {
    return quotaGroups.find(
      (g) => g.name.toLowerCase().includes("claude") || g.name.toLowerCase().includes("gpt"),
    )
  }
  return undefined
}

/** Evaluate whether a model's plan quota bucket is available and format its display badge. */
export function evaluateModelQuotaStatus(
  spec: AgyModelSpec,
  quotaGroups: readonly AgyQuotaGroup[],
): {
  readonly displayName: string
  readonly available: boolean
  readonly badge: string
  readonly groupName?: string
  readonly resetHint?: string
} {
  const group = matchQuotaGroupForModel(spec.id, quotaGroups)
  if (!group || group.buckets.length === 0) {
    return {
      displayName: spec.name,
      available: true,
      badge: "plan active",
    }
  }

  let available = true
  let exhaustedReset: string | undefined
  const parts: string[] = []

  for (const b of group.buckets) {
    const pct = Math.round(b.remainingFraction * 100)
    const winLabel = b.window === "weekly" ? "wk" : b.window ?? "quota"
    parts.push(`${pct}% ${winLabel}`)
    if (pct <= 0) {
      available = false
      if (!exhaustedReset && b.resetTime) {
        exhaustedReset = formatResetTime(b.resetTime)
      }
    }
  }

  const badge = parts.join(" · ")
  const baseName = spec.name.replace(/\s*\(Antigravity\)\s*$/, "")
  const displayName = `${baseName} (Antigravity · ${available ? badge : `0% limit · ${badge}`})`

  return {
    displayName,
    available,
    badge,
    groupName: group.name,
    resetHint: exhaustedReset,
  }
}

/** Infer the user's Antigravity plan tier from `/usage` quota group structure. */
export function detectPlanTier(quotaGroups: readonly AgyQuotaGroup[]): string {
  const argonGroup = quotaGroups.find(
    (g) =>
      g.name.toLowerCase().includes("argon") ||
      g.buckets.some((b) => b.id.includes("argon")),
  )
  if (argonGroup) {
    return "Pro Plan (Separate Argon + Gemini + Claude/GPT Pools)"
  }
  if (quotaGroups.length > 0) {
    return "Ultra / Shared Pool Plan"
  }
  return "Antigravity Plan"
}

export interface AgyPlanCatalog {
  readonly models: readonly AgyModelSpec[]
  readonly quotaGroups: readonly AgyQuotaGroup[]
  readonly remainingCredits?: number
  readonly planTier: string
  readonly recommendedDefaultModel: string
}

/** Query `agy models`, `agy -p "/usage"`, and `agy -p "/credits"` to initialize plan-aware models. */
export async function discoverPlanCatalog(
  agyBin: string,
  workspaceDir: string,
  env: Record<string, string>,
  preferredDefaultModel: string,
): Promise<AgyPlanCatalog> {
  const [modelsRes, quotaGroups, creditsRes] = await Promise.all([
    runAgyBuffered(agyBin, ["models"], workspaceDir, env, 5).catch(() => undefined),
    fetchAgyQuotaGroups(agyBin, workspaceDir, env),
    runAgyBuffered(agyBin, ["-p", "/credits", "--output-format", "json"], workspaceDir, env, 5).catch(
      () => undefined,
    ),
  ])

  const models = modelsRes?.stdout ? parseAgyModelsOutput(modelsRes.stdout) : AGY_MODEL_SPECS

  let remainingCredits: number | undefined
  if (creditsRes?.stdout) {
    for (const rawLine of creditsRes.stdout.split("\n")) {
      const line = rawLine.trim()
      if (!line.startsWith("{")) continue
      try {
        const parsed = JSON.parse(line) as Record<string, any>
        if (typeof parsed?.command?.data?.remaining_credits === "number") {
          remainingCredits = parsed.command.data.remaining_credits
        }
      } catch {
        // Ignore malformed JSON.
      }
    }
  }

  const planTier = detectPlanTier(quotaGroups)

  // Choose recommended model: keep preferredDefaultModel if available & has quota; otherwise pick first model with >0% quota
  const preferredSpec = models.find((m) => m.id === preferredDefaultModel) ?? models[0]
  let recommendedDefaultModel = preferredSpec?.id ?? preferredDefaultModel
  if (preferredSpec && quotaGroups.length > 0) {
    const status = evaluateModelQuotaStatus(preferredSpec, quotaGroups)
    if (!status.available) {
      const fallback = models.find((m) => evaluateModelQuotaStatus(m, quotaGroups).available)
      if (fallback) {
        recommendedDefaultModel = fallback.id
      }
    }
  }

  return {
    models,
    quotaGroups,
    remainingCredits,
    planTier,
    recommendedDefaultModel,
  }
}

/** Build the dedicated `/usage` Markdown report for `agy/*` models. */
export async function buildAgyUsageReport(params: {
  readonly sessionID: string
  readonly modelId: string
  readonly variant?: string
  readonly agyBin: string
  readonly workspaceDir: string
  readonly env: Record<string, string>
  readonly preferredDefaultModel: string
  readonly catalog?: AgyPlanCatalog
}): Promise<{ readonly report: string; readonly catalog: AgyPlanCatalog }> {
  const catalog =
    params.catalog ??
    (await discoverPlanCatalog(
      params.agyBin,
      params.workspaceDir,
      params.env,
      params.preferredDefaultModel,
    ))

  const activeSpec =
    catalog.models.find((m) => m.id === params.modelId) ??
    AGY_MODEL_MAP.get(params.modelId) ??
    catalog.models[0]!
  const activeVariant = params.variant ?? activeSpec.defaultVariant
  const activeStatus = evaluateModelQuotaStatus(activeSpec, catalog.quotaGroups)

  const lines: string[] = [
    "```text",
    "╭────────────────────────────────────────────────────────────╮",
    "│            Antigravity (agy) Plan & Quota Usage            │",
    "╰────────────────────────────────────────────────────────────╯",
    "",
    `Detected Plan:   ${catalog.planTier}`,
    ...(catalog.remainingCredits !== undefined ? [`G1 Credits:      ${catalog.remainingCredits}`] : []),
    `Active Model:    agy/${activeSpec.id}${activeVariant ? `#${activeVariant}` : ""} (${activeStatus.available ? `✓ Available · ${activeStatus.badge}` : `⚠️ Quota Exhausted · ${activeStatus.badge}`})`,
    `Plan Models:     ${catalog.models.length} model families initialized from agy`,
    "```",
  ]

  if (catalog.quotaGroups.length > 0) {
    lines.push("")
    lines.push("### Quota Buckets (`/usage`)")
    lines.push("")
    lines.push("| Model Group | Window | Status | Remaining | Reset (Local) |")
    lines.push("| :--- | :--- | :--- | :--- | :--- |")
    for (const group of catalog.quotaGroups) {
      for (const bucket of group.buckets) {
        const remPct = Math.round(bucket.remainingFraction * 100)
        const bar = createBar(remPct, 100, 10, "█", "░")
        const status = remPct > 0 ? "✓ Active" : "⚠️ Exhausted"
        const reset = formatResetTime(bucket.resetTime)
        lines.push(
          `| **${group.name}** | ${bucket.window ?? bucket.name} | ${status} | \`${bar}\` **${remPct}%** | ${reset} |`,
        )
      }
    }
  }

  lines.push("")
  lines.push("### Initialized Plan Models (`agy/*`)")
  lines.push("")
  lines.push("| OpenCode Model | Variants | Default | Quota Pool | Plan Status |")
  lines.push("| :--- | :--- | :--- | :--- | :--- |")
  for (const spec of catalog.models) {
    const st = evaluateModelQuotaStatus(spec, catalog.quotaGroups)
    const variantsStr = spec.variants?.length ? spec.variants.map((v) => `\`${v}\``).join(", ") : "—"
    const defStr = spec.defaultVariant ? `\`#${spec.defaultVariant}\`` : "—"
    const poolStr = st.groupName ?? "—"
    const statusStr = st.available
      ? `✓ Available (\`${st.badge}\`)`
      : `⚠️ Limit 0%${st.resetHint ? ` (resets ${st.resetHint})` : ""}`
    lines.push(`| \`agy/${spec.id}\` | ${variantsStr} | ${defStr} | ${poolStr} | ${statusStr} |`)
  }

  return {
    report: lines.join("\n"),
    catalog,
  }
}

/** Serialize an `AgyPlanCatalog` into a compact DTO for the TUI right-sidebar widget. */
export function buildUsageSnapshotDto(catalog: AgyPlanCatalog): {
  readonly planTier: string
  readonly remainingCredits: number | null
  readonly quotaGroups: readonly {
    readonly modelGroup: string
    readonly window: string
    readonly remainingPct: number
    readonly resetUtc: string
  }[]
  readonly updatedAt: string
} {
  const quotaGroups: {
    readonly modelGroup: string
    readonly window: string
    readonly remainingPct: number
    readonly resetUtc: string
  }[] = []

  for (const group of catalog.quotaGroups) {
    for (const bucket of group.buckets) {
      quotaGroups.push({
        modelGroup: group.name,
        window: bucket.window ?? bucket.name,
        remainingPct: Math.max(0, Math.min(100, Math.round(bucket.remainingFraction * 100))),
        resetUtc: bucket.resetTime ?? "",
      })
    }
  }

  return {
    planTier: catalog.planTier,
    remainingCredits: catalog.remainingCredits ?? null,
    quotaGroups,
    updatedAt: new Date().toISOString(),
  }
}

