import type {
  AgyAgentFailureDto,
  AgyAgentStatus,
  AgyAgentsSnapshotDto,
  AgySubagentDto,
  AgySwarmDto,
  AgySwarmMemberDto,
  AgySwarmPostDto,
  AgyUsageBucketDto,
  AgyUsageSnapshotDto,
} from "./rpc.ts"

export function shortGroupLabel(groupName: string, windowName: string, compact = false): string {
  const g = String(groupName ?? "").trim()
  const w = String(windowName ?? "").trim()
  const shortWin = w.toLowerCase() === "weekly" ? "wk" : w
  if (/argon/i.test(g)) return shortWin ? `Argon · ${shortWin}` : "Argon"
  if (/claude|gpt/i.test(g)) {
    const base = compact ? "Claude" : "Claude/GPT"
    return shortWin ? `${base} · ${shortWin}` : base
  }
  if (/gemini/i.test(g)) return shortWin ? `Gemini · ${shortWin}` : "Gemini"
  const prefix = g.slice(0, compact ? 8 : 12)
  return shortWin ? `${prefix} · ${shortWin}` : prefix
}

export function formatResetCountdown(isoReset: string, nowMs: number): string {
  if (!isoReset) return ""
  const target = new Date(isoReset).getTime()
  if (!Number.isFinite(target)) return ""
  const diffMs = target - nowMs
  if (diffMs <= 0) return "now"
  const totalMins = Math.max(1, Math.round(diffMs / 60_000))
  const days = Math.floor(totalMins / (60 * 24))
  const hours = Math.floor((totalMins % (60 * 24)) / 60)
  const mins = totalMins % 60
  if (days > 0) return `${days}d${hours}h`
  if (hours > 0) return `${hours}h${mins}m`
  return `${mins}m`
}

export function buildAsciiBar(pct: number, width = 7): string {
  const safeWidth = Math.max(1, width)
  const clamped = Math.max(0, Math.min(100, Math.round(pct)))
  const filled = Math.round((clamped / 100) * safeWidth)
  return "█".repeat(filled) + "░".repeat(Math.max(0, safeWidth - filled))
}

export function parseUsageSnapshotDto(rawJson: unknown): AgyUsageSnapshotDto | null {
  if (typeof rawJson !== "string" || !rawJson.trim()) return null
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return null
    const planTier =
      typeof parsed.planTier === "string" && parsed.planTier.trim()
        ? parsed.planTier.trim()
        : "Antigravity Plan"
    const remainingCredits =
      typeof parsed.remainingCredits === "number" && Number.isFinite(parsed.remainingCredits)
        ? parsed.remainingCredits
        : null
    const rawGroups = Array.isArray(parsed.quotaGroups) ? parsed.quotaGroups : []
    const quotaGroups: AgyUsageBucketDto[] = rawGroups
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => ({
        modelGroup: typeof item.modelGroup === "string" ? item.modelGroup : "Unknown",
        window: typeof item.window === "string" ? item.window : "",
        remainingPct:
          typeof item.remainingPct === "number" && Number.isFinite(item.remainingPct)
            ? Math.max(0, Math.min(100, Math.round(item.remainingPct)))
            : 0,
        resetUtc: typeof item.resetUtc === "string" ? item.resetUtc : "",
      }))

    return {
      planTier,
      remainingCredits,
      quotaGroups,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {}),
    }
  } catch {
    return null
  }
}

export function formatPlanBadge(snapshot: AgyUsageSnapshotDto | null): string {
  if (!snapshot) return ""
  const rawTier = snapshot.planTier?.trim() ?? ""
  let tier = "AGY"
  if (/\bpro\b/i.test(rawTier)) tier = "PRO"
  else if (/\bultra\b/i.test(rawTier)) tier = "ULTRA"
  else if (/\bfree\b/i.test(rawTier)) tier = "FREE"
  else if (/\bstandard\b/i.test(rawTier)) tier = "STD"
  else if (rawTier && rawTier !== "Antigravity Plan" && rawTier !== "unknown") {
    tier = rawTier.split(/\s+/)[0]!.toUpperCase().slice(0, 6)
  }
  const creds = snapshot.remainingCredits !== null ? ` · ${snapshot.remainingCredits}cr` : ""
  return `${tier}${creds}`
}

export function formatHeaderTitle(snapshot: AgyUsageSnapshotDto | null, width: number): string {
  const badge = formatPlanBadge(snapshot)
  const full = badge ? `Antigravity (${badge})` : "Antigravity Quota"
  if (full.length + 12 <= width) return full
  const compact = badge ? `AGY (${badge})` : "AGY Quota"
  if (compact.length + 12 <= width) return compact
  return width >= 22 ? "AGY Quota" : "AGY"
}

export function formatBucketLine(
  bucket: AgyUsageBucketDto,
  nowMs: number,
  width: number,
  maxLabelWidth?: number,
): string {
  const compactLabels = width < 38
  const rawLabel = shortGroupLabel(bucket.modelGroup, bucket.window, compactLabels)
  const pct = Math.max(0, Math.min(100, Math.round(Number(bucket.remainingPct ?? 0))))
  const pctStr = `${pct}%`.padStart(4, " ")
  const reset = formatResetCountdown(bucket.resetUtc, nowMs)
  const showReset = Boolean(reset) && width >= 30
  const resetPart = showReset ? ` ${reset}` : ""
  const barWidth = width >= 40 ? 8 : width >= 32 ? 6 : 4
  const bar = buildAsciiBar(pct, barWidth)
  const rightSide = `${bar} ${pctStr}${resetPart}`

  const targetLabelWidth = Math.max(
    8,
    Math.min(maxLabelWidth ?? rawLabel.length, Math.max(8, width - rightSide.length - 1)),
  )
  const clippedLabel =
    rawLabel.length > targetLabelWidth
      ? `${rawLabel.slice(0, Math.max(1, targetLabelWidth - 1))}…`
      : rawLabel.padEnd(targetLabelWidth, " ")

  const gap = Math.max(1, width - clippedLabel.length - rightSide.length)
  return `${clippedLabel}${" ".repeat(gap)}${rightSide}`
}

export function formatSyncFooter(updatedAt: string | undefined, width: number): string {
  if (!updatedAt) return width >= 34 ? "Sync pending · click [↻] to refresh" : "Sync pending"
  const d = new Date(updatedAt)
  if (Number.isNaN(d.getTime())) return "click [↻] or /agy-refresh"
  const pad = (n: number) => String(n).padStart(2, "0")
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const full = `Sync ${hhmm} · click [↻] or /agy-refresh`
  if (full.length <= width) return full
  const medium = `Sync ${hhmm} · /agy-refresh`
  if (medium.length <= width) return medium
  return `Sync ${hhmm}`
}

const VALID_AGENT_STATUSES = new Set<AgyAgentStatus>([
  "working",
  "waiting",
  "done",
  "blocked",
  "stuck",
  "quota",
  "error",
  "killed",
])

function normalizeAgentStatus(raw: unknown): AgyAgentStatus {
  return typeof raw === "string" && VALID_AGENT_STATUSES.has(raw as AgyAgentStatus)
    ? (raw as AgyAgentStatus)
    : "working"
}

function parseFailureDto(raw: unknown): AgyAgentFailureDto | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const rec = raw as Record<string, unknown>
  const text = typeof rec.text === "string" ? rec.text : ""
  if (!text) return undefined
  return {
    kind: rec.kind === "quota" ? "quota" : "error",
    text,
  }
}

export function parseAgentsSnapshotDto(rawJson: unknown): AgyAgentsSnapshotDto | null {
  if (typeof rawJson !== "string" || !rawJson.trim()) return null
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object") return null

    let swarm: AgySwarmDto | null = null
    if (parsed.swarm && typeof parsed.swarm === "object") {
      const s = parsed.swarm as Record<string, unknown>
      const rawMembers = Array.isArray(s.members) ? s.members : []
      const members: AgySwarmMemberDto[] = rawMembers
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((m) => {
          const failure = parseFailureDto(m.failure)
          return {
            name: typeof m.name === "string" ? m.name : "worker",
            role: typeof m.role === "string" ? m.role : "worker",
            conversationId: typeof m.conversationId === "string" ? m.conversationId : "",
            model: typeof m.model === "string" ? m.model : "",
            status: normalizeAgentStatus(m.status),
            workspaceMode: typeof m.workspaceMode === "string" ? m.workspaceMode : "inherit",
            ...(typeof m.workspace === "string" && m.workspace ? { workspace: m.workspace } : {}),
            steps: typeof m.steps === "number" && Number.isFinite(m.steps) ? m.steps : 0,
            contextTokens:
              typeof m.contextTokens === "number" && Number.isFinite(m.contextTokens) ? m.contextTokens : 0,
            outputTokens:
              typeof m.outputTokens === "number" && Number.isFinite(m.outputTokens) ? m.outputTokens : 0,
            activity: typeof m.activity === "string" ? m.activity : "",
            activityKind:
              m.activityKind === "tool" || m.activityKind === "thinking" ? m.activityKind : "",
            ...(typeof m.blockedTool === "string" && m.blockedTool ? { blockedTool: m.blockedTool } : {}),
            posts: typeof m.posts === "number" && Number.isFinite(m.posts) ? m.posts : 0,
            unread: typeof m.unread === "number" && Number.isFinite(m.unread) ? m.unread : 0,
            ...(typeof m.lastPostTime === "string" && m.lastPostTime ? { lastPostTime: m.lastPostTime } : {}),
            transcriptMtime:
              typeof m.transcriptMtime === "number" && Number.isFinite(m.transcriptMtime)
                ? m.transcriptMtime
                : 0,
            ...(failure ? { failure } : {}),
            ...(m.roleWorker ? { roleWorker: true } : {}),
          }
        })

      const rawPosts = Array.isArray(s.recentPosts) ? s.recentPosts : []
      const recentPosts: AgySwarmPostDto[] = rawPosts
        .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
        .map((p) => ({
          seq: typeof p.seq === "number" && Number.isFinite(p.seq) ? p.seq : 0,
          agent: typeof p.agent === "string" ? p.agent : "",
          text: typeof p.text === "string" ? p.text : "",
          time: typeof p.time === "string" ? p.time : "",
          ...(typeof p.kind === "string" && p.kind ? { kind: p.kind } : {}),
        }))

      swarm = {
        swarmId: typeof s.swarmId === "string" ? s.swarmId : "",
        title: typeof s.title === "string" && s.title ? s.title : "Swarm",
        head: typeof s.head === "number" && Number.isFinite(s.head) ? s.head : 0,
        postCount: typeof s.postCount === "number" && Number.isFinite(s.postCount) ? s.postCount : 0,
        ...(typeof s.goalTitle === "string" && s.goalTitle ? { goalTitle: s.goalTitle } : {}),
        ...(typeof s.goalLine === "string" && s.goalLine ? { goalLine: s.goalLine } : {}),
        members,
        recentPosts,
      }
    }

    const rawSubs = Array.isArray(parsed.subagents) ? parsed.subagents : []
    const subagents: AgySubagentDto[] = rawSubs
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((sub) => {
        const failure = parseFailureDto(sub.failure)
        return {
          conversationId: typeof sub.conversationId === "string" ? sub.conversationId : "",
          typeName: typeof sub.typeName === "string" ? sub.typeName : "subagent",
          role: typeof sub.role === "string" ? sub.role : "Subagent",
          model: typeof sub.model === "string" ? sub.model : "",
          status: normalizeAgentStatus(sub.status),
          steps: typeof sub.steps === "number" && Number.isFinite(sub.steps) ? sub.steps : 0,
          contextTokens:
            typeof sub.contextTokens === "number" && Number.isFinite(sub.contextTokens) ? sub.contextTokens : 0,
          outputTokens:
            typeof sub.outputTokens === "number" && Number.isFinite(sub.outputTokens) ? sub.outputTokens : 0,
          activity: typeof sub.activity === "string" ? sub.activity : "",
          activityKind:
            sub.activityKind === "tool" || sub.activityKind === "thinking" ? sub.activityKind : "",
          ...(typeof sub.blockedTool === "string" && sub.blockedTool ? { blockedTool: sub.blockedTool } : {}),
          ...(typeof sub.spawnStepIndex === "number" && Number.isFinite(sub.spawnStepIndex)
            ? { spawnStepIndex: sub.spawnStepIndex }
            : {}),
          workspaceUris: Array.isArray(sub.workspaceUris)
            ? sub.workspaceUris.filter((u): u is string => typeof u === "string")
            : [],
          ...(typeof sub.initialPrompt === "string" && sub.initialPrompt ? { initialPrompt: sub.initialPrompt } : {}),
          ...(typeof sub.lastMessage === "string" && sub.lastMessage ? { lastMessage: sub.lastMessage } : {}),
          ...(typeof sub.startedAt === "string" && sub.startedAt ? { startedAt: sub.startedAt } : {}),
          ...(typeof sub.updatedAt === "string" && sub.updatedAt ? { updatedAt: sub.updatedAt } : {}),
          transcriptMtime:
            typeof sub.transcriptMtime === "number" && Number.isFinite(sub.transcriptMtime)
              ? sub.transcriptMtime
              : 0,
          ...(failure ? { failure } : {}),
        }
      })

    return {
      sessionID: typeof parsed.sessionID === "string" ? parsed.sessionID : "",
      ...(typeof parsed.conversationId === "string" && parsed.conversationId
        ? { conversationId: parsed.conversationId }
        : {}),
      swarm,
      subagents,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    }
  } catch {
    return null
  }
}

export function shortAgentModelLabel(modelId: string, compact = false): string {
  const m = String(modelId ?? "").trim()
  if (!m) return ""
  const effortMatch = /-(low|medium|high|xhigh|max)$/i.exec(m)
  const effortRaw = effortMatch?.[1]?.toLowerCase() ?? ""
  const effortShort =
    effortRaw === "xhigh"
      ? "XH"
      : effortRaw === "high"
        ? "H"
        : effortRaw === "medium"
          ? "M"
          : effortRaw === "low"
            ? "L"
            : effortRaw === "max"
              ? "Max"
              : ""
  const effortLabel =
    effortRaw === "xhigh"
      ? "XHigh"
      : effortRaw === "medium"
        ? "Med"
        : effortRaw
          ? effortRaw.charAt(0).toUpperCase() + effortRaw.slice(1)
          : ""

  let base = m.replace(/-(low|medium|high|xhigh|max)$/i, "")
  if (/orchestrator/i.test(base)) return "Orch Argon"
  if (/hydrogen/i.test(base)) base = compact ? "H2" : "Hydrogen"
  else if (/argon/i.test(base)) base = "Argon"
  else if (/flash/i.test(base)) base = "Flash"
  else if (/opus/i.test(base)) base = "Opus 5.5"
  else if (/sonnet/i.test(base)) base = "Sonnet 5.5"
  else if (/gpt-oss/i.test(base)) return "GPT-OSS"
  else base = base.slice(0, 12)

  if (!effortLabel) return base
  return compact ? `${base} ${effortShort}` : `${base} (${effortLabel})`
}

export function agentStatusSymbol(status: AgyAgentStatus): string {
  if (status === "working") return "●"
  if (status === "waiting") return "○"
  if (status === "done") return "✓"
  if (status === "blocked" || status === "stuck" || status === "quota") return "⚠"
  return "✗"
}

export function formatAgentStatusLabel(status: AgyAgentStatus, blockedTool?: string): string {
  if (status === "working") return "Active"
  if (status === "waiting") return "Waiting"
  if (status === "done") return "Done"
  if (status === "killed") return "Killed"
  if (status === "quota") return "Quota"
  if (status === "error") return "Error"
  if (status === "stuck") return "Stuck"
  if (status === "blocked") return blockedTool ? `Blocked · ${blockedTool}` : "Blocked"
  return status
}

export function formatCompactAgentTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return ""
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
  return String(Math.round(tokens))
}

export function formatRelativeAge(mtimeMs: number, nowMs: number): string {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return ""
  const diffSec = Math.max(0, Math.round((nowMs - mtimeMs) / 1000))
  if (diffSec < 60) return diffSec <= 5 ? "now" : `${diffSec}s`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.round(diffMin / 60)
  return `${diffHr}h`
}

function clipText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ""
  if (text.length <= maxWidth) return text
  return maxWidth === 1 ? "…" : `${text.slice(0, maxWidth - 1).trimEnd()}…`
}

function padSplitRow(left: string, right: string, width: number): string {
  const safeWidth = Math.max(12, width)
  const rightStr = right.trim()
  if (!rightStr) return clipText(left, safeWidth)
  const maxLeft = Math.max(6, safeWidth - rightStr.length - 1)
  const clippedLeft = clipText(left, maxLeft)
  const gap = Math.max(1, safeWidth - clippedLeft.length - rightStr.length)
  return `${clippedLeft}${" ".repeat(gap)}${rightStr}`
}

export function formatSwarmHeaderTitle(swarm: AgySwarmDto, width: number): string {
  const cleanTitle = swarm.title.replace(/\s+/g, " ").trim() || "Swarm"
  const budget = Math.max(12, width - 9)
  return clipText(`🐝 ${cleanTitle}`, budget)
}

export function formatSwarmMetaLine(swarm: AgySwarmDto, width: number): string {
  const activeCount = swarm.members.filter((m) => m.status === "working" || m.status === "blocked").length
  const liveCount = swarm.members.filter((m) => m.status !== "killed").length
  const summary =
    activeCount > 0
      ? `${activeCount} active · ${liveCount}/${swarm.members.length} live · ${swarm.postCount}p`
      : `${liveCount}/${swarm.members.length} live · ${swarm.postCount} posts`
  if (swarm.goalLine && width >= summary.length + 14) {
    return clipText(`${summary} · ${swarm.goalLine}`, width)
  }
  return clipText(summary, width)
}

export function formatSwarmMemberPrimaryLine(member: AgySwarmMemberDto, width: number): string {
  const sym = agentStatusSymbol(member.status)
  const model = shortAgentModelLabel(member.model, width < 38)
  const roleTag = member.role === "coordinator" ? "coord" : member.roleWorker ? member.role : ""
  const metaParts = [roleTag, model].filter(Boolean)
  const left = metaParts.length > 0 ? `${sym} ${member.name} (${metaParts.join(" · ")})` : `${sym} ${member.name}`
  const right = formatAgentStatusLabel(member.status, width >= 34 ? member.blockedTool : undefined)
  return padSplitRow(left, right, width)
}

function composeActivityAndChips(
  activity: string,
  activityKind: "tool" | "thinking" | "",
  chips: readonly string[],
  width: number,
): string {
  const safeWidth = Math.max(12, width)
  if (!activity) {
    const suffix = chips.join(" · ")
    return suffix ? clipText(`  ${suffix}`, safeWidth) : ""
  }
  const prefix = activityKind === "thinking" ? "  💭 " : "  ▸ "
  const minActivityChars = Math.min(activity.length, Math.max(10, Math.floor(safeWidth * 0.45)))
  const keptChips: string[] = []
  let usedLen = prefix.length + minActivityChars
  for (const chip of chips) {
    const addLen = 3 + chip.length
    if (usedLen + addLen <= safeWidth) {
      keptChips.push(chip)
      usedLen += addLen
    }
  }
  const suffix = keptChips.join(" · ")
  if (!suffix) {
    return clipText(`${prefix}${activity}`, safeWidth)
  }
  const joiner = ` · ${suffix}`
  const actBudget = Math.max(6, safeWidth - prefix.length - joiner.length)
  return `${prefix}${clipText(activity, actBudget)}${joiner}`
}

export function formatSwarmMemberDetailLine(
  member: AgySwarmMemberDto,
  nowMs: number,
  width: number,
): string {
  if (member.failure) {
    return clipText(`  ⚠ ${member.failure.text}`, width)
  }
  if (member.blockedTool) {
    return clipText(`  ⚠ Waiting on ${member.blockedTool}`, width)
  }

  const chips: string[] = []
  if (member.steps > 0) chips.push(`${member.steps}s`)
  if (member.posts > 0) chips.push(`${member.posts}p`)
  if (member.unread > 0) chips.push(`+${member.unread}u`)
  const tok = formatCompactAgentTokens(member.contextTokens)
  if (tok) chips.push(tok)
  if (member.workspaceMode && member.workspaceMode !== "inherit") {
    chips.push(member.workspaceMode)
  }
  const age = formatRelativeAge(member.transcriptMtime, nowMs)
  if (age && !member.activity) chips.push(age)

  return composeActivityAndChips(member.activity, member.activityKind, chips, width)
}

export function formatSwarmBoardPreviewLine(post: AgySwarmPostDto, width: number): string {
  const body = post.text.replace(/\s+/g, " ").trim()
  return clipText(`  #${post.seq} @${post.agent}: ${body}`, width)
}

export function formatSubagentsHeaderTitle(subagents: readonly AgySubagentDto[], width: number): string {
  const activeCount = subagents.filter(
    (s) => s.status === "working" || s.status === "blocked" || s.status === "stuck",
  ).length
  const title =
    activeCount > 0
      ? `Subagents (${activeCount} active · ${subagents.length})`
      : `Subagents (${subagents.length})`
  return clipText(title, width)
}

export function formatSubagentPrimaryLine(sub: AgySubagentDto, width: number): string {
  const sym = agentStatusSymbol(sub.status)
  const model = shortAgentModelLabel(sub.model, width < 38)
  const left = model ? `${sym} ${sub.role} (${model})` : `${sym} ${sub.role}`
  const right = formatAgentStatusLabel(sub.status, width >= 34 ? sub.blockedTool : undefined)
  return padSplitRow(left, right, width)
}

export function formatSubagentDetailLine(sub: AgySubagentDto, nowMs: number, width: number): string {
  if (sub.failure) {
    return clipText(`  ⚠ ${sub.failure.text}`, width)
  }
  if (sub.blockedTool) {
    return clipText(`  ⚠ Waiting on ${sub.blockedTool}`, width)
  }

  const chips: string[] = []
  if (!sub.activity && sub.typeName && sub.typeName !== sub.role) {
    chips.push(sub.typeName)
  }
  if (sub.steps > 0) chips.push(`${sub.steps}s`)
  const tok = formatCompactAgentTokens(sub.contextTokens)
  if (tok) chips.push(tok)
  const age = formatRelativeAge(sub.transcriptMtime, nowMs)
  if (age) chips.push(age)

  return composeActivityAndChips(sub.activity, sub.activityKind, chips, width)
}
