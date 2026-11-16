import type { AgyUsageBucketDto, AgyUsageSnapshotDto } from "./rpc.ts"

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
