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

export type AgyAgentStatus =
  | "working"
  | "waiting"
  | "done"
  | "blocked"
  | "stuck"
  | "quota"
  | "error"
  | "killed"

export interface AgyAgentFailureDto {
  readonly kind: "quota" | "error"
  readonly text: string
}

export interface AgySwarmMemberDto {
  readonly name: string
  readonly role: string
  readonly conversationId: string
  readonly model: string
  readonly status: AgyAgentStatus
  readonly workspaceMode: string
  readonly workspace?: string
  readonly steps: number
  readonly contextTokens: number
  readonly outputTokens: number
  readonly activity: string
  readonly activityKind: "tool" | "thinking" | ""
  readonly blockedTool?: string
  readonly posts: number
  readonly unread: number
  readonly lastPostTime?: string
  readonly transcriptMtime: number
  readonly failure?: AgyAgentFailureDto
  readonly roleWorker?: boolean
}

export interface AgySwarmPostDto {
  readonly seq: number
  readonly agent: string
  readonly text: string
  readonly time: string
  readonly kind?: string
}

export interface AgySwarmDto {
  readonly swarmId: string
  readonly title: string
  readonly head: number
  readonly postCount: number
  readonly goalTitle?: string
  readonly goalLine?: string
  readonly members: readonly AgySwarmMemberDto[]
  readonly recentPosts: readonly AgySwarmPostDto[]
}

export interface AgySubagentDto {
  readonly conversationId: string
  readonly typeName: string
  readonly role: string
  readonly model: string
  readonly status: AgyAgentStatus
  readonly steps: number
  readonly contextTokens: number
  readonly outputTokens: number
  readonly activity: string
  readonly activityKind: "tool" | "thinking" | ""
  readonly blockedTool?: string
  readonly spawnStepIndex?: number
  readonly workspaceUris: readonly string[]
  readonly initialPrompt?: string
  readonly lastMessage?: string
  readonly startedAt?: string
  readonly updatedAt?: string
  readonly transcriptMtime: number
  readonly failure?: AgyAgentFailureDto
}

export interface AgyAgentsSnapshotDto {
  readonly sessionID: string
  readonly conversationId?: string
  readonly swarm: AgySwarmDto | null
  readonly subagents: readonly AgySubagentDto[]
  readonly updatedAt: string
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
    getAgents: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
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
    agentsUpdated: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          json: { type: "string" },
        },
        required: ["json"],
        additionalProperties: false,
      },
    },
  },
} as const
