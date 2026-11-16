/**
 * Shared RPC contract between the Antigravity server plugin and TUI sidebar widget.
 * Uses plain JSON Schema definitions so both server and TUI can import it with zero extra dependencies.
 */
export interface AgyUsageBucketDto {
  readonly modelGroup: string
  readonly window: string
  readonly remainingPct: number
  readonly resetUtc: string
}

export interface AgyUsageSnapshotDto {
  readonly planTier: string
  readonly remainingCredits: number | null
  readonly quotaGroups: readonly AgyUsageBucketDto[]
  readonly updatedAt: string
  readonly error?: string
}

export const AgyUsageRpc = {
  id: "opencode.agy.usage",
  methods: {
    getUsage: {
      input: {
        type: "object",
        properties: {
          forceRefresh: { type: "boolean" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          json: { type: "string" },
        },
        required: ["json"],
        additionalProperties: false,
      },
    },
  },
  events: {
    updated: {
      schema: {
        type: "object",
        properties: {
          json: { type: "string" },
        },
        required: ["json"],
        additionalProperties: false,
      },
    },
  },
} as const
