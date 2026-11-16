export const PROVIDER_ID = "agy" as const
export const PLUGIN_ID = "agy" as const
export const DEFAULT_MODEL_ID = "gemini-4-hydrogen"
export const DEFAULT_VARIANT_ID = "medium"
export const DEFAULT_TOOL_MODEL = "gemini-4-hydrogen-medium"
export const DEFAULT_TIMEOUT_SECONDS = 600
export const DEFAULT_CONTEXT_WINDOW = 1_000_000
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000
export const CONTEXT_REPORT_MARKER = "Antigravity (agy) Context Analysis"
export const USAGE_REPORT_MARKER = "Antigravity (agy) Plan & Quota Usage"
export const MAX_OUTPUT_BYTES = 100 * 1024
export const MAX_CAPTURE_BYTES = 2 * 1024 * 1024
export const MAX_PROMPT_CHARS = 120_000
export const MAX_HISTORY_ENTRY_CHARS = 1_500

export const DEFAULT_READONLY_AGENTS: readonly string[] = ["plan", "reviewer", "explore"]

export const SKIP_INSTRUCTION_KEYS: ReadonlySet<string> = new Set([
  "core/codemode",
  "core/skill-guidance",
  "core/date",
  "core/environment",
])

export interface AgyModelSpec {
  readonly id: string
  readonly name: string
  readonly variants?: readonly string[]
  readonly defaultVariant?: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
}

export const AGY_MODEL_SPECS: readonly AgyModelSpec[] = [
  {
    id: "gemini-4-hydrogen",
    name: "Gemini 4 Hydrogen (Antigravity)",
    variants: ["low", "medium", "high", "xhigh"],
    defaultVariant: "medium",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon (Antigravity)",
    variants: ["low", "medium", "high"],
    defaultVariant: "high",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash (Antigravity)",
    variants: ["low", "medium", "high"],
    defaultVariant: "medium",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    id: "gemini-pro-orchestrator-g1-pro",
    name: "Orchestrator Argon (Antigravity)",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5 (Antigravity)",
    variants: ["low", "medium", "high"],
    defaultVariant: "high",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5 (Antigravity)",
    variants: ["low", "medium", "high"],
    defaultVariant: "high",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
  },
  {
    id: "gpt-oss-120b-medium",
    name: "GPT-OSS 120B Medium (Antigravity)",
    contextWindow: 128_000,
    maxOutputTokens: 32_000,
  },
]

export const AGY_MODEL_MAP: ReadonlyMap<string, AgyModelSpec> = new Map(
  AGY_MODEL_SPECS.map((spec) => [spec.id, spec]),
)

export type AgyExecutionMode = "accept-edits" | "auto" | "plan"

export interface AgyConnectorConfig {
  readonly binaryPath?: string
  readonly defaultModel: string
  readonly defaultVariant?: string
  readonly defaultToolModel: string
  readonly timeoutSeconds: number
  readonly mode: AgyExecutionMode
  readonly allowAllTools: boolean
  readonly readOnlyAgents: ReadonlySet<string>
  readonly registerProvider: boolean
  readonly registerTool: boolean
  readonly registerCommand: boolean
  readonly registerSkill: boolean
}

export interface AgyToolInput {
  readonly prompt: string
  readonly model?: string
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max"
  readonly mode?: "plan" | "accept-edits" | "auto" | "default"
  readonly conversation_id?: string
  readonly timeout_seconds?: number
  readonly allow_all_tools?: boolean
  readonly add_dirs?: string[]
  readonly disable_slash_commands?: boolean
}

export interface AgyUsage {
  readonly input_tokens?: number
  readonly output_tokens?: number
  readonly thinking_tokens?: number
  readonly cache_read_tokens?: number
  readonly total_tokens?: number
}

export interface AgyJsonResult {
  readonly conversation_id?: string
  readonly status?: string
  readonly response?: string
  readonly error?: string
  readonly finished_reason?: string
  readonly duration_seconds?: number
  readonly num_turns?: number
  readonly usage?: AgyUsage
}

export interface AgyErrorPayload {
  readonly short_error?: string
  readonly status?: string
  readonly retryable?: boolean
  readonly reason?: string
}

export interface ParsedOutput {
  readonly result?: AgyJsonResult
  readonly agyError?: AgyErrorPayload
  readonly permissionBlocked?: string
  readonly cleanedStdout: string
  readonly cleanedStderr: string
}

export interface AgyMeta {
  readonly sessionID: string
  readonly agent: string
  readonly kind: "primary" | "compaction" | "generate"
  readonly instructions: string
}

export interface V3Usage {
  readonly inputTokens: {
    readonly total: number | undefined
    readonly noCache: number | undefined
    readonly cacheRead: number | undefined
    readonly cacheWrite: number | undefined
  }
  readonly outputTokens: {
    readonly total: number | undefined
    readonly text: number | undefined
    readonly reasoning: number | undefined
  }
}

/** Parse and validate OpenCode plugin options into normalized connector defaults. */
export function parseConnectorConfig(rawOptions: Record<string, unknown> | undefined): AgyConnectorConfig {
  const opts = rawOptions ?? {}
  const binaryPath =
    typeof opts.binaryPath === "string" && opts.binaryPath.trim() ? opts.binaryPath.trim() : undefined

  const rawModel =
    typeof opts.defaultModel === "string" && AGY_MODEL_MAP.has(opts.defaultModel.trim())
      ? opts.defaultModel.trim()
      : DEFAULT_MODEL_ID
  const spec = AGY_MODEL_MAP.get(rawModel)

  let defaultVariant: string | undefined
  if (spec?.variants && spec.variants.length > 0) {
    const candidate = typeof opts.defaultVariant === "string" ? opts.defaultVariant.trim() : undefined
    defaultVariant =
      candidate && spec.variants.includes(candidate) ? candidate : spec.defaultVariant ?? spec.variants[0]
  }

  const defaultToolModel =
    typeof opts.defaultToolModel === "string" && opts.defaultToolModel.trim()
      ? opts.defaultToolModel.trim()
      : resolveProviderCliModel(rawModel, defaultVariant)

  const timeoutSeconds =
    typeof opts.timeoutSeconds === "number" && Number.isFinite(opts.timeoutSeconds)
      ? Math.max(0, Math.floor(opts.timeoutSeconds))
      : DEFAULT_TIMEOUT_SECONDS

  const rawMode = typeof opts.mode === "string" ? opts.mode.trim() : ""
  const mode: AgyExecutionMode =
    rawMode === "auto" || rawMode === "plan" || rawMode === "accept-edits" ? rawMode : "accept-edits"

  const extraReadOnly = Array.isArray(opts.readOnlyAgents)
    ? opts.readOnlyAgents
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : undefined

  const readOnlyAgents = new Set(extraReadOnly && extraReadOnly.length > 0 ? extraReadOnly : DEFAULT_READONLY_AGENTS)

  return {
    binaryPath,
    defaultModel: rawModel,
    defaultVariant,
    defaultToolModel,
    timeoutSeconds,
    mode,
    allowAllTools: opts.allowAllTools === true,
    readOnlyAgents,
    registerProvider: opts.registerProvider !== false,
    registerTool: opts.registerTool !== false,
    registerCommand: opts.registerCommand !== false,
    registerSkill: opts.registerSkill !== false,
  }
}

/** Map an OpenCode agy model id and effort variant onto an exact `agy models` identifier. */
export function resolveProviderCliModel(modelId: string, effort?: string): string {
  const spec = AGY_MODEL_MAP.get(modelId)
  if (!spec?.variants || spec.variants.length === 0) return modelId
  const chosen = effort && spec.variants.includes(effort) ? effort : spec.defaultVariant ?? spec.variants[0]
  return `${spec.id}-${chosen}`
}
