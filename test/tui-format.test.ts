import assert from "node:assert/strict"
import test from "node:test"
import { buildUsageSnapshotDto } from "../src/context.ts"
import { AgyUsageRpc } from "../src/rpc.ts"
import {
  agentStatusSymbol,
  buildAsciiBar,
  formatAgentStatusLabel,
  formatBucketLine,
  formatCompactAgentTokens,
  formatHeaderTitle,
  formatPlanBadge,
  formatResetCountdown,
  formatSubagentDetailLine,
  formatSubagentPrimaryLine,
  formatSubagentsHeaderTitle,
  formatSwarmBoardPreviewLine,
  formatSwarmHeaderTitle,
  formatSwarmMemberDetailLine,
  formatSwarmMemberPrimaryLine,
  formatSwarmMetaLine,
  formatSyncFooter,
  parseAgentsSnapshotDto,
  parseUsageSnapshotDto,
  shortAgentModelLabel,
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

test("parseAgentsSnapshotDto and swarm/subagent sidebar formatters adapt to width", () => {
  const now = Date.parse("2026-11-18T20:05:00Z")
  const raw = JSON.stringify({
    sessionID: "ses_123",
    conversationId: "coord-1234",
    swarm: {
      swarmId: "coord-1234",
      title: "Phase 3 Refactor",
      head: 4,
      postCount: 4,
      goalTitle: "Refactor UI",
      goalLine: "Split cards & verify",
      members: [
        {
          name: "coordinator",
          role: "coordinator",
          conversationId: "coord-1234",
          model: "gemini-4-hydrogen-xhigh",
          status: "waiting",
          workspaceMode: "inherit",
          steps: 12,
          contextTokens: 32000,
          outputTokens: 600,
          activity: "Waiting for posts",
          activityKind: "tool",
          posts: 2,
          unread: 0,
          transcriptMtime: now - 15_000,
        },
        {
          name: "parser",
          role: "worker",
          conversationId: "work-1",
          model: "gemini-3.8-flash-low",
          status: "working",
          workspaceMode: "share",
          steps: 5,
          contextTokens: 18400,
          outputTokens: 210,
          activity: "Edit parser.ts",
          activityKind: "tool",
          posts: 1,
          unread: 1,
          transcriptMtime: now - 2_000,
        },
      ],
      recentPosts: [
        { seq: 4, agent: "parser", text: "@coordinator Updated parser.ts cleanly", time: "2026-11-18 20:04:50" },
      ],
    },
    subagents: [
      {
        conversationId: "sub-1",
        typeName: "research",
        role: "Schema Reader",
        model: "gemini-3.8-flash-low",
        status: "blocked",
        blockedTool: "AskQuestion",
        steps: 3,
        contextTokens: 9200,
        outputTokens: 80,
        activity: "",
        activityKind: "",
        workspaceUris: ["file:///repo"],
        transcriptMtime: now - 60_000,
      },
    ],
    updatedAt: "2026-11-18T20:05:00Z",
  })

  const parsed = parseAgentsSnapshotDto(raw)
  assert.ok(parsed?.swarm)
  assert.equal(parsed.swarm.members.length, 2)
  assert.equal(parsed.subagents.length, 1)

  assert.equal(shortAgentModelLabel("gemini-4-hydrogen-xhigh", true), "H2 XH")
  assert.equal(shortAgentModelLabel("gemini-4-hydrogen-xhigh", false), "Hydrogen (XHigh)")
  assert.equal(agentStatusSymbol("working"), "●")
  assert.equal(formatAgentStatusLabel("blocked", "AskQuestion"), "Blocked · AskQuestion")
  assert.equal(formatCompactAgentTokens(18400), "18k")

  assert.equal(formatSwarmHeaderTitle(parsed.swarm, 40), "🐝 Phase 3 Refactor")
  assert.match(formatSwarmMetaLine(parsed.swarm, 40), /1 active · 2\/2 live · 4p/)

  const coordLine1 = formatSwarmMemberPrimaryLine(parsed.swarm.members[0]!, 38)
  assert.ok(coordLine1.length <= 38)
  assert.match(coordLine1, /○ coordinator/)
  assert.match(coordLine1, /Waiting$/)

  const workerDetail = formatSwarmMemberDetailLine(parsed.swarm.members[1]!, now, 40)
  assert.ok(workerDetail.length <= 40)
  assert.match(workerDetail, /▸ Edit parser\.ts/)
  assert.match(workerDetail, /5s/)

  const workerDetailWide = formatSwarmMemberDetailLine(parsed.swarm.members[1]!, now, 52)
  assert.match(workerDetailWide, /▸ Edit parser\.ts/)
  assert.match(workerDetailWide, /share/)

  assert.match(formatSwarmBoardPreviewLine(parsed.swarm.recentPosts[0]!, 40), /#4 @parser:/)
  assert.equal(formatSubagentsHeaderTitle(parsed.subagents, 36), "Subagents (1 active · 1)")
  assert.match(formatSubagentPrimaryLine(parsed.subagents[0]!, 40), /Blocked · AskQuestion$/)
  assert.match(formatSubagentDetailLine(parsed.subagents[0]!, now, 40), /Waiting on AskQuestion/)
})
