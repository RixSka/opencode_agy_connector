import assert from "node:assert/strict"
import test from "node:test"
import { buildUsageSnapshotDto } from "../src/context.ts"
import { AgyUsageRpc } from "../src/rpc.ts"
import {
  buildAsciiBar,
  formatBucketLine,
  formatHeaderTitle,
  formatPlanBadge,
  formatResetCountdown,
  formatSyncFooter,
  parseUsageSnapshotDto,
  shortGroupLabel,
} from "../src/tui-format.ts"

test("buildUsageSnapshotDto and parseUsageSnapshotDto round-trip quota snapshot", () => {
  const dto = buildUsageSnapshotDto({
    models: [],
    planTier: "Pro Plan (Separate Argon + Gemini + Claude/GPT Pools)",
    remainingCredits: 950,
    recommendedDefaultModel: "gemini-4-hydrogen",
    quotaGroups: [
      {
        name: "Gemini Models",
        buckets: [
          {
            id: "gemini-weekly",
            name: "Weekly",
            window: "weekly",
            remainingFraction: 0.624,
            resetTime: "2026-11-21T15:23:01Z",
          },
          {
            id: "gemini-5h",
            name: "5h",
            window: "5h",
            remainingFraction: 0,
            resetTime: "2026-11-16T05:12:51Z",
          },
        ],
      },
      {
        name: "Gemini 4 Argon",
        buckets: [
          {
            id: "gemini-argon-wtu-weekly",
            name: "Weekly",
            window: "weekly",
            remainingFraction: 0.65,
            resetTime: "2026-11-22T17:12:51Z",
          },
        ],
      },
    ],
  })

  const parsed = parseUsageSnapshotDto(JSON.stringify(dto))
  assert.ok(parsed)
  assert.equal(parsed.planTier, "Pro Plan (Separate Argon + Gemini + Claude/GPT Pools)")
  assert.equal(parsed.remainingCredits, 950)
  assert.equal(parsed.quotaGroups.length, 3)
  assert.deepEqual(parsed.quotaGroups[0], {
    modelGroup: "Gemini Models",
    window: "weekly",
    remainingPct: 62,
    resetUtc: "2026-11-21T15:23:01Z",
  })
  assert.equal(parsed.quotaGroups[1]?.remainingPct, 0)
  assert.equal(formatPlanBadge(parsed), "PRO · 950cr")
  assert.equal(formatHeaderTitle(parsed, 42), "Antigravity (PRO · 950cr)")
  assert.equal(formatHeaderTitle(parsed, 32), "AGY (PRO · 950cr)")
})

test("sidebar formatting adapts cleanly across sidebar widths", () => {
  assert.equal(shortGroupLabel("Claude and GPT models", "weekly", false), "Claude/GPT · wk")
  assert.equal(shortGroupLabel("Claude and GPT models", "5h", true), "Claude · 5h")
  assert.equal(shortGroupLabel("Gemini 4 Argon", "weekly", false), "Argon · wk")
  assert.equal(buildAsciiBar(50, 8), "████░░░░")

  const now = Date.parse("2026-11-16T04:00:00Z")
  assert.equal(formatResetCountdown("2026-11-16T05:30:00Z", now), "1h30m")
  assert.equal(formatResetCountdown("2026-11-18T06:00:00Z", now), "2d2h")
  assert.equal(formatResetCountdown("2026-11-16T03:00:00Z", now), "now")

  const lineWide = formatBucketLine(
    {
      modelGroup: "Claude and GPT models",
      window: "weekly",
      remainingPct: 99,
      resetUtc: "2026-11-23T00:00:00Z",
    },
    now,
    40,
    15,
  )
  assert.equal(lineWide.length, 40)
  assert.match(lineWide, /^Claude\/GPT · wk\s+████████\s+99%\s+6d20h$/)

  const lineNarrow = formatBucketLine(
    {
      modelGroup: "Claude and GPT models",
      window: "weekly",
      remainingPct: 99,
      resetUtc: "2026-11-23T00:00:00Z",
    },
    now,
    30,
    11,
  )
  assert.ok(lineNarrow.length <= 30)
  assert.match(lineNarrow, /Claude · wk/)
  assert.match(lineNarrow, /99%/)

  assert.match(formatSyncFooter("2026-11-16T04:15:00Z", 40), /Sync \d{2}:\d{2} · click \[↻\]/)
  assert.equal(AgyUsageRpc.id, "opencode.agy.usage")
})
