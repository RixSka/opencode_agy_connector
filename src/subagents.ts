import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type {
  AgyAgentFailureDto,
  AgyAgentStatus,
  AgyAgentsSnapshotDto,
  AgySubagentDto,
  AgySwarmDto,
  AgySwarmMemberDto,
  AgySwarmPostDto,
} from "./rpc.ts"

const SAFE_CONV_ID = /^[a-zA-Z0-9_-]{4,128}$/
const STUCK_MS = 10 * 60 * 1000
const STEP_ERROR_SETTLE_MS = 60 * 1000
const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i
const ROLE_WORKER_RE = /^(?:narrator|monitor)(?:-\d+)?$/
const BLOCKING_TOOLS = new Set(["ask_permission", "ask_custom_permission", "ask_question"])

const BOARD_ACTIVITY: Record<string, string> = {
  swarm_wait: "Waiting for posts",
  read_board: "Reading the board",
  post_message: "Posting to the board",
}

export interface LiveStreamSubagent {
  readonly conversationId?: string
  readonly typeName: string
  readonly role: string
  readonly initialPrompt?: string
  readonly workspaceUris?: readonly string[]
  readonly spawnStepIndex?: number
}

interface TranscriptSummary {
  readonly steps: number
  readonly model: string
  readonly contextTokens: number
  readonly outputTokens: number
  readonly activity: string
  readonly activityKind: "tool" | "thinking" | ""
  readonly blockedTool?: string
  readonly idle: boolean
  readonly failure?: AgyAgentFailureDto
  readonly initialPrompt?: string
  readonly lastMessage?: string
  readonly startedAt?: string
  readonly updatedAt?: string
  readonly mtime: number
}

function oneLine(text: unknown, maxLen = 120): string {
  const cleaned = String(text ?? "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned) return ""
  return cleaned.length > maxLen ? `${cleaned.slice(0, Math.max(1, maxLen - 1)).trimEnd()}…` : cleaned
}

function unquote(value: unknown): string {
  if (typeof value !== "string") return value == null ? "" : String(value)
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return String(JSON.parse(trimmed))
    } catch {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

function describeToolCall(tc: Record<string, unknown> | undefined): string {
  const name = typeof tc?.name === "string" ? tc.name : ""
  if (!name) return ""
  if (BOARD_ACTIVITY[name]) return BOARD_ACTIVITY[name]!

  const args = tc?.args && typeof tc.args === "object" ? (tc.args as Record<string, unknown>) : {}
  const summary = unquote(args.toolSummary) || unquote(args.toolAction)
  if (summary) return oneLine(summary, 96)

  const filePath = unquote(args.Path || args.AbsolutePath || args.TargetFile)
  if (filePath) {
    const base = path.basename(filePath)
    if (name === "read_file" || name === "view_file") return `Read ${base}`
    if (name === "write_file" || name === "write_to_file") return `Write ${base}`
    if (name === "edit_file" || name === "replace_file_content" || name === "multi_replace_file_content") {
      return `Edit ${base}`
    }
  }

  if ((name === "code_search" || name === "grep_search") && args.Query) {
    return oneLine(`Search ${unquote(args.Query)}`, 96)
  }
  if (name === "swarm" && args.action) {
    const targetName = unquote(args.name)
    return oneLine(`swarm ${unquote(args.action)}${targetName ? ` ${targetName}` : ""}`, 96)
  }
  if (name === "invoke_subagent") {
    const role = unquote(args.Role || args.TypeName)
    return role ? oneLine(`Spawn ${role}`, 96) : "Spawn subagent"
  }
  if (name === "run_command" && args.CommandLine) {
    return oneLine(`Run ${unquote(args.CommandLine)}`, 96)
  }
  return name
}

function thinkingHeading(thinking: unknown): string {
  if (typeof thinking !== "string") return ""
  const matches = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,96})\*\*\s*(?=\n|$)/g)]
  const last = matches.at(-1)
  return last?.[1] ? oneLine(last[1], 96) : ""
}

function formatBlockingToolLabel(name: string): string {
  if (name === "ask_question") return "AskQuestion"
  if (name === "ask_permission" || name === "ask_custom_permission") return "Permission"
  return name
}

function extractMessageContent(rawContent: string): string {
  const sysMatch = /\bcontent=([\s\S]*?)\n<\/SYSTEM_MESSAGE>/i.exec(rawContent)
  if (sysMatch?.[1]) return sysMatch[1].trim()
  const reqMatch = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(rawContent)
  if (reqMatch?.[1]) return reqMatch[1].trim()
  return rawContent.trim()
}

function parseSteps(rawText: string): Record<string, any>[] {
  const out: Record<string, any>[] = []
  for (const rawLine of rawText.split("\n")) {
    const line = rawLine.trim()
    if (!line.startsWith("{")) continue
    try {
      const parsed = JSON.parse(line) as Record<string, any>
      if (parsed && typeof parsed === "object") out.push(parsed)
    } catch {
      // Ignore partially written trailing line during live streaming.
    }
  }
  return out
}

function computeTurnState(steps: readonly Record<string, any>[]): {
  readonly idle: boolean
  readonly blockedTool?: string
} {
  const results: Record<string, any>[] = []
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i]
    if (!step) continue
    if (step.type === "GENERIC") {
      results.unshift(step)
      continue
    }
    if (step.type !== "PLANNER_RESPONSE") {
      return { idle: false }
    }

    const calls = Array.isArray(step.tool_calls) ? (step.tool_calls as Record<string, any>[]) : []
    if (calls.length === 0) {
      return { idle: results.length === 0 }
    }

    for (let idx = 0; idx < calls.length; idx++) {
      const callName = typeof calls[idx]?.name === "string" ? calls[idx]!.name : ""
      if (!BLOCKING_TOOLS.has(callName)) continue
      const res = results[idx]
      if (!res || res.status !== "DONE") {
        return { idle: false, blockedTool: formatBlockingToolLabel(callName) }
      }
    }

    const waitIdx = calls.findIndex((c) => c?.name === "swarm_wait")
    const parked = waitIdx >= 0 && results.length >= calls.length && results[waitIdx]?.status === "DONE"
    return { idle: parked }
  }
  return { idle: false }
}

function summarizeTranscript(appDataDir: string, conversationId: string, nowMs: number): TranscriptSummary | null {
  if (!conversationId || !SAFE_CONV_ID.test(conversationId)) return null
  const transcriptPath = path.join(
    appDataDir,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl",
  )
  if (!existsSync(transcriptPath)) return null

  let mtime = 0
  let rawText = ""
  try {
    mtime = statSync(transcriptPath).mtimeMs
    rawText = readFileSync(transcriptPath, "utf8")
  } catch {
    return null
  }

  const parsedSteps = parseSteps(rawText)
  if (parsedSteps.length === 0) return null

  let stepCount = parsedSteps.length
  let model = ""
  let contextTokens = 0
  let outputTokens = 0
  let initialPrompt: string | undefined
  let lastMessage: string | undefined
  let startedAt: string | undefined
  let updatedAt: string | undefined

  for (const step of parsedSteps) {
    if (typeof step.step_index === "number" && Number.isFinite(step.step_index)) {
      stepCount = Math.max(stepCount, step.step_index + 1)
    }
    if (typeof step.created_at === "string" && step.created_at) {
      if (!startedAt) startedAt = step.created_at
      updatedAt = step.created_at
    }
    if (!initialPrompt && (step.type === "USER_INPUT" || step.type === "SYSTEM_MESSAGE")) {
      if (typeof step.content === "string" && step.content.trim()) {
        initialPrompt = oneLine(extractMessageContent(step.content), 240)
      }
    }
    if (step.type === "PLANNER_RESPONSE") {
      if (typeof step.model === "string" && step.model.trim()) {
        model = step.model.trim()
      }
      const inTok = typeof step.input_tokens === "number" ? step.input_tokens : 0
      const cacheTok = typeof step.cache_read_tokens === "number" ? step.cache_read_tokens : 0
      const outTok = typeof step.output_tokens === "number" ? step.output_tokens : 0
      if (inTok + cacheTok > 0) contextTokens = inTok + cacheTok
      outputTokens += outTok
      if (typeof step.content === "string" && step.content.trim()) {
        lastMessage = oneLine(step.content, 240)
      }
      const calls = Array.isArray(step.tool_calls) ? step.tool_calls : []
      for (const tc of calls) {
        if (tc?.name === "send_message" && tc.args && typeof tc.args === "object") {
          const msg = unquote((tc.args as Record<string, unknown>).Message)
          if (msg) lastMessage = oneLine(msg, 240)
        }
      }
    }
  }

  let activity = ""
  let activityKind: "tool" | "thinking" | "" = ""
  for (let i = parsedSteps.length - 1; i >= 0; i--) {
    const step = parsedSteps[i]
    if (!step) continue
    if (step.type === "USER_INPUT") break
    if (step.type !== "PLANNER_RESPONSE") continue
    const calls = Array.isArray(step.tool_calls) ? (step.tool_calls as Record<string, unknown>[]) : []
    if (calls.some((tc) => tc?.name === "swarm_wait")) break

    const labels = calls.map((tc) => describeToolCall(tc)).filter(Boolean)
    const lastLabel = labels.at(-1) ?? ""
    const heading = thinkingHeading(step.thinking)
    if (lastLabel) {
      activity = lastLabel
      activityKind = "tool"
      break
    }
    if (heading) {
      activity = heading
      activityKind = "thinking"
      break
    }
  }

  const newest = parsedSteps.at(-1)
  let failure: AgyAgentFailureDto | undefined
  if (newest) {
    const modelError = newest.type === "ERROR_MESSAGE"
    const settledToolError = newest.status === "ERROR" && mtime > 0 && nowMs - mtime >= STEP_ERROR_SETTLE_MS
    if (modelError || settledToolError) {
      const errText =
        typeof newest.error === "string" && newest.error.trim()
          ? oneLine(newest.error, 200)
          : modelError
            ? "model error"
            : "step failed"
      failure = {
        kind: QUOTA_RE.test(errText) ? "quota" : "error",
        text: errText,
      }
    }
  }

  const turnState = computeTurnState(parsedSteps)

  return {
    steps: stepCount,
    model,
    contextTokens,
    outputTokens,
    activity,
    activityKind,
    ...(turnState.blockedTool ? { blockedTool: turnState.blockedTool } : {}),
    idle: turnState.idle,
    ...(failure ? { failure } : {}),
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(lastMessage ? { lastMessage } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    mtime,
  }
}

function getAppDataCandidates(homeDir: string): string[] {
  return [
    path.join(homeDir, ".gemini", "antigravity-cli"),
    path.join(homeDir, ".gemini", "antigravity"),
  ]
}

function resolveBrainLocation(
  conversationId: string,
  homeDir: string,
): { readonly appDataDir: string; readonly sysDir: string } | null {
  if (!conversationId || !SAFE_CONV_ID.test(conversationId.trim())) return null
  const cid = conversationId.trim()
  for (const appDataDir of getAppDataCandidates(homeDir)) {
    const sysDir = path.join(appDataDir, "brain", cid, ".system_generated")
    if (
      existsSync(path.join(sysDir, "swarm", "members.json")) ||
      existsSync(path.join(sysDir, "swarm", "swarm.json")) ||
      existsSync(path.join(sysDir, "subagents")) ||
      existsSync(path.join(sysDir, "logs", "transcript.jsonl"))
    ) {
      return { appDataDir, sysDir }
    }
  }
  return null
}

/** Return `true` when an Antigravity conversation currently has a swarm directory on disk. */
export function hasActiveAgySwarm(conversationId: string | undefined, homeDir: string = os.homedir()): boolean {
  if (!conversationId || !SAFE_CONV_ID.test(conversationId.trim())) return false
  const cid = conversationId.trim()
  for (const appDataDir of getAppDataCandidates(homeDir)) {
    const swarmDir = path.join(appDataDir, "brain", cid, ".system_generated", "swarm")
    if (existsSync(path.join(swarmDir, "members.json")) || existsSync(path.join(swarmDir, "swarm.json"))) {
      return true
    }
  }
  return false
}

function roleOfMember(name: string, rawMember: Record<string, unknown>): string {
  const r = typeof rawMember.role === "string" ? rawMember.role.trim() : ""
  if (r && r !== "worker") return r
  const match = /^(narrator|monitor)(?:-\d+)?$/.exec(name)
  return match?.[1] ?? (r || "worker")
}

function isRoleWorker(name: string, role: string): boolean {
  return Boolean((role && role !== "worker" && role !== "coordinator") || ROLE_WORKER_RE.test(name))
}

function resolveSwarmMemberStatus(
  rawMember: Record<string, unknown>,
  tr: TranscriptSummary | null,
  nowMs: number,
): AgyAgentStatus {
  if (rawMember.killed) return "killed"
  if (tr?.failure) return tr.failure.kind
  if (tr?.blockedTool) return "blocked"
  if (tr) {
    if (tr.idle) return "waiting"
    if (tr.mtime > 0 && nowMs - tr.mtime > STUCK_MS) return "stuck"
    return "working"
  }
  const wake = typeof rawMember.wake_mode === "string" ? rawMember.wake_mode : ""
  return wake === "mentions" || wake === "anything" ? "waiting" : "working"
}

function readSwarmSection(
  appDataDir: string,
  sysDir: string,
  conversationId: string,
  nowMs: number,
): { readonly swarm: AgySwarmDto | null; readonly memberConvIds: ReadonlySet<string> } {
  const swarmDir = path.join(sysDir, "swarm")
  const membersPath = path.join(swarmDir, "members.json")
  const memberConvIds = new Set<string>()

  if (!existsSync(membersPath)) {
    return { swarm: null, memberConvIds }
  }

  let rosterRaw: Record<string, any>
  try {
    rosterRaw = JSON.parse(readFileSync(membersPath, "utf8")) as Record<string, any>
  } catch {
    return { swarm: null, memberConvIds }
  }

  const membersObj =
    rosterRaw.members && typeof rosterRaw.members === "object"
      ? (rosterRaw.members as Record<string, Record<string, unknown>>)
      : {}

  const boardPosts: AgySwarmPostDto[] = []
  const postStats = new Map<string, { count: number; lastTime: string }>()
  let head = 0
  const boardPath = path.join(swarmDir, "board.jsonl")
  if (existsSync(boardPath)) {
    try {
      const boardText = readFileSync(boardPath, "utf8")
      for (const rawLine of boardText.split("\n")) {
        const line = rawLine.trim()
        if (!line.startsWith("{")) continue
        try {
          const msg = JSON.parse(line) as Record<string, unknown>
          const seq = typeof msg.seq === "number" ? msg.seq : boardPosts.length + 1
          const agent = typeof msg.agent === "string" ? msg.agent : ""
          const text = typeof msg.text === "string" ? msg.text : ""
          const time = typeof msg.time === "string" ? msg.time : ""
          const kind = typeof msg.kind === "string" ? msg.kind : undefined
          head = Math.max(head, seq)
          if (agent) {
            const prev = postStats.get(agent) ?? { count: 0, lastTime: "" }
            postStats.set(agent, { count: prev.count + 1, lastTime: time || prev.lastTime })
          }
          boardPosts.push({
            seq,
            agent,
            text,
            time,
            ...(kind ? { kind } : {}),
          })
        } catch {
          // Ignore partial board line.
        }
      }
    } catch {
      // Ignore unreadable board.
    }
  }

  let goalTitle: string | undefined
  let goalLine: string | undefined
  const planPath = path.join(swarmDir, "plan.json")
  if (existsSync(planPath)) {
    try {
      const plan = JSON.parse(readFileSync(planPath, "utf8")) as Record<string, any>
      if (typeof plan?.goal?.title === "string" && plan.goal.title.trim()) {
        goalTitle = plan.goal.title.trim()
      }
      if (typeof plan?.goal?.line === "string" && plan.goal.line.trim()) {
        goalLine = plan.goal.line.trim()
      }
    } catch {
      // Ignore invalid plan.json.
    }
  }

  const members: AgySwarmMemberDto[] = Object.entries(membersObj)
    .filter(([, value]) => Boolean(value && typeof value === "object"))
    .map(([name, raw]) => {
      const convId = typeof raw.conversation_id === "string" ? raw.conversation_id : ""
      if (convId) memberConvIds.add(convId)
      const tr = convId ? summarizeTranscript(appDataDir, convId, nowMs) : null
      const role = roleOfMember(name, raw)
      const roleWorker = isRoleWorker(name, role)
      const model =
        (typeof raw.model === "string" && raw.model) ||
        (typeof raw.applied_model === "string" && raw.applied_model) ||
        (typeof raw.desired_model === "string" && raw.desired_model) ||
        tr?.model ||
        ""
      const lastRead = typeof raw.last_read_seq === "number" ? raw.last_read_seq : 0
      const stats = postStats.get(name) ?? { count: 0, lastTime: "" }

      return {
        name,
        role,
        conversationId: convId,
        model,
        status: resolveSwarmMemberStatus(raw, tr, nowMs),
        workspaceMode: typeof raw.workspace_mode === "string" ? raw.workspace_mode : "inherit",
        ...(typeof raw.workspace === "string" && raw.workspace ? { workspace: raw.workspace } : {}),
        steps: tr?.steps ?? 0,
        contextTokens: tr?.contextTokens ?? 0,
        outputTokens: tr?.outputTokens ?? 0,
        activity: tr?.activity ?? "",
        activityKind: tr?.activityKind ?? "",
        ...(tr?.blockedTool ? { blockedTool: tr.blockedTool } : {}),
        posts: stats.count,
        unread: Math.max(0, head - lastRead),
        ...(stats.lastTime ? { lastPostTime: stats.lastTime } : {}),
        transcriptMtime: tr?.mtime ?? 0,
        ...(tr?.failure ? { failure: tr.failure } : {}),
        ...(roleWorker ? { roleWorker: true } : {}),
      }
    })

  members.sort((a, b) => {
    const rank = (m: AgySwarmMemberDto): number => {
      if (m.role === "coordinator") return 0
      if (m.status === "killed") return 3
      if (m.roleWorker) return 2
      return 1
    }
    return rank(a) - rank(b) || a.name.localeCompare(b.name)
  })

  const title =
    (typeof rosterRaw.title === "string" && rosterRaw.title.trim()) ||
    goalTitle ||
    `Swarm ${conversationId.slice(0, 8)}`

  return {
    swarm: {
      swarmId: conversationId,
      title,
      head,
      postCount: boardPosts.length,
      ...(goalTitle ? { goalTitle } : {}),
      ...(goalLine ? { goalLine } : {}),
      members,
      recentPosts: boardPosts.slice(-20),
    },
    memberConvIds,
  }
}

function resolveSubagentStatus(rawState: string, tr: TranscriptSummary | null): AgyAgentStatus {
  if (rawState === "SUBAGENT_STATE_KILLED") return "killed"
  if (tr?.failure) return tr.failure.kind
  if (tr?.blockedTool) return "blocked"
  if (tr) {
    return tr.idle ? "done" : "working"
  }
  return "working"
}

function readSubagentsList(
  appDataDir: string,
  sysDir: string,
  excludedConvIds: ReadonlySet<string>,
  streamSubagents: readonly LiveStreamSubagent[],
  nowMs: number,
): AgySubagentDto[] {
  const byConvId = new Map<string, AgySubagentDto>()
  const subagentsDir = path.join(sysDir, "subagents")

  if (existsSync(subagentsDir)) {
    let files: string[] = []
    try {
      files = readdirSync(subagentsDir).filter((f) => f.endsWith(".json"))
    } catch {
      files = []
    }

    for (const file of files) {
      try {
        const raw = JSON.parse(readFileSync(path.join(subagentsDir, file), "utf8")) as Record<string, any>
        const convId =
          typeof raw.conversationId === "string" && raw.conversationId
            ? raw.conversationId
            : file.replace(/\.json$/i, "")
        if (!convId || excludedConvIds.has(convId)) continue

        const desc = (raw.subagentDescriptor ?? {}) as Record<string, unknown>
        const typeName = typeof desc.typeName === "string" && desc.typeName ? desc.typeName : "subagent"
        const role = typeof desc.role === "string" && desc.role ? desc.role : typeName
        const rawState = typeof raw.state === "string" ? raw.state : ""
        const tr = summarizeTranscript(appDataDir, convId, nowMs)
        const workspaceUris = Array.isArray(raw.workspaceUris)
          ? raw.workspaceUris.filter((u): u is string => typeof u === "string")
          : []

        byConvId.set(convId, {
          conversationId: convId,
          typeName,
          role,
          model: tr?.model ?? "",
          status: resolveSubagentStatus(rawState, tr),
          steps: tr?.steps ?? 0,
          contextTokens: tr?.contextTokens ?? 0,
          outputTokens: tr?.outputTokens ?? 0,
          activity: tr?.activity ?? "",
          activityKind: tr?.activityKind ?? "",
          ...(tr?.blockedTool ? { blockedTool: tr.blockedTool } : {}),
          ...(typeof raw.spawnStepIndex === "number" ? { spawnStepIndex: raw.spawnStepIndex } : {}),
          workspaceUris,
          ...(tr?.initialPrompt ? { initialPrompt: tr.initialPrompt } : {}),
          ...(tr?.lastMessage ? { lastMessage: tr.lastMessage } : {}),
          ...(tr?.startedAt ? { startedAt: tr.startedAt } : {}),
          ...(tr?.updatedAt ? { updatedAt: tr.updatedAt } : {}),
          transcriptMtime: tr?.mtime ?? 0,
          ...(tr?.failure ? { failure: tr.failure } : {}),
        })
      } catch {
        // Ignore malformed subagent metadata file.
      }
    }
  }

  for (const live of streamSubagents) {
    const cid = live.conversationId?.trim() || ""
    if (cid && (excludedConvIds.has(cid) || byConvId.has(cid))) continue
    const key = cid || `pending_${live.spawnStepIndex ?? byConvId.size}_${live.role}`
    if (byConvId.has(key)) continue
    const tr = cid ? summarizeTranscript(appDataDir, cid, nowMs) : null
    byConvId.set(key, {
      conversationId: cid,
      typeName: live.typeName || "subagent",
      role: live.role || live.typeName || "Subagent",
      model: tr?.model ?? "",
      status: tr ? resolveSubagentStatus("", tr) : "working",
      steps: tr?.steps ?? 0,
      contextTokens: tr?.contextTokens ?? 0,
      outputTokens: tr?.outputTokens ?? 0,
      activity: tr?.activity ?? (cid ? "" : "Starting…"),
      activityKind: tr?.activityKind ?? "",
      ...(tr?.blockedTool ? { blockedTool: tr.blockedTool } : {}),
      ...(live.spawnStepIndex !== undefined ? { spawnStepIndex: live.spawnStepIndex } : {}),
      workspaceUris: live.workspaceUris ?? [],
      ...(tr?.initialPrompt ?? live.initialPrompt
        ? { initialPrompt: tr?.initialPrompt ?? oneLine(live.initialPrompt, 240) }
        : {}),
      ...(tr?.lastMessage ? { lastMessage: tr.lastMessage } : {}),
      ...(tr?.startedAt ? { startedAt: tr.startedAt } : {}),
      ...(tr?.updatedAt ? { updatedAt: tr.updatedAt } : {}),
      transcriptMtime: tr?.mtime ?? nowMs,
      ...(tr?.failure ? { failure: tr.failure } : {}),
    })
  }

  const list = [...byConvId.values()]
  list.sort((a, b) => {
    const isLive = (s: AgyAgentStatus) => (s === "working" || s === "blocked" || s === "stuck" ? 0 : 1)
    return (
      isLive(a.status) - isLive(b.status) ||
      (b.spawnStepIndex ?? 0) - (a.spawnStepIndex ?? 0) ||
      b.transcriptMtime - a.transcriptMtime
    )
  })
  return list
}

/** Build a live snapshot of Antigravity swarm members and subagents for an OpenCode session. */
export function readAgyAgentsSnapshot(params: {
  readonly sessionID: string
  readonly conversationId?: string
  readonly streamSubagents?: readonly LiveStreamSubagent[]
  readonly homeDir?: string
  readonly nowMs?: number
}): AgyAgentsSnapshotDto {
  const nowMs = params.nowMs ?? Date.now()
  const updatedAt = new Date(nowMs).toISOString()
  const cid = params.conversationId?.trim()

  if (!cid) {
    return {
      sessionID: params.sessionID,
      swarm: null,
      subagents: [],
      updatedAt,
    }
  }

  const homeDir = params.homeDir ?? os.homedir()
  const located = resolveBrainLocation(cid, homeDir)
  if (!located) {
    const pendingSubs = (params.streamSubagents ?? []).map(
      (live, idx): AgySubagentDto => ({
        conversationId: live.conversationId ?? "",
        typeName: live.typeName || "subagent",
        role: live.role || live.typeName || `Subagent ${idx + 1}`,
        model: "",
        status: "working",
        steps: 0,
        contextTokens: 0,
        outputTokens: 0,
        activity: "Starting…",
        activityKind: "",
        ...(live.spawnStepIndex !== undefined ? { spawnStepIndex: live.spawnStepIndex } : {}),
        workspaceUris: live.workspaceUris ?? [],
        ...(live.initialPrompt ? { initialPrompt: oneLine(live.initialPrompt, 240) } : {}),
        transcriptMtime: nowMs,
      }),
    )
    return {
      sessionID: params.sessionID,
      conversationId: cid,
      swarm: null,
      subagents: pendingSubs,
      updatedAt,
    }
  }

  const { swarm, memberConvIds } = readSwarmSection(located.appDataDir, located.sysDir, cid, nowMs)
  const subagents = readSubagentsList(
    located.appDataDir,
    located.sysDir,
    memberConvIds,
    params.streamSubagents ?? [],
    nowMs,
  )

  return {
    sessionID: params.sessionID,
    conversationId: cid,
    swarm,
    subagents,
    updatedAt,
  }
}
