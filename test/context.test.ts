import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import {
  buildAgyContextReport,
  buildAgyUsageReport,
  detectPlanTier,
  evaluateModelQuotaStatus,
  getAgyTranscriptPath,
  parseAgyModelsOutput,
  readAgyTranscriptSummary,
} from "../src/context.ts"

test("readAgyTranscriptSummary and buildAgyContextReport compute exact step context and breakdown", async () => {
  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "agy-ctx-test-"))
  const convId = "7b9f0225-07e5-45e5-bc5a-39348c35e5cb"
  try {
    const transcriptFile = getAgyTranscriptPath(convId, tmpHome)
    mkdirSync(path.dirname(transcriptFile), { recursive: true })

    const lines = [
      JSON.stringify({
        step_index: 0,
        type: "USER_INPUT",
        content: "<USER_REQUEST>\nTriage local apps\n</USER_REQUEST>",
      }),
      JSON.stringify({
        step_index: 1,
        type: "PLANNER_RESPONSE",
        model: "gemini-4-hydrogen-medium",
        input_tokens: 13242,
        cache_read_tokens: 0,
        output_tokens: 736,
        tool_calls: [{ name: "run_command", args: { CommandLine: "ls -la" } }],
      }),
      JSON.stringify({
        step_index: 2,
        type: "GENERIC",
        content: "Command output: total 16",
      }),
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        model: "gemini-4-hydrogen-medium",
        input_tokens: 3097,
        cache_read_tokens: 37984,
        output_tokens: 2756,
        tool_calls: [],
      }),
    ]
    writeFileSync(transcriptFile, lines.join("\n") + "\n", "utf8")

    const summary = readAgyTranscriptSummary(convId, tmpHome)
    assert.ok(summary)
    assert.equal(summary.plannerStepCount, 2)
    assert.equal(summary.totalToolCalls, 1)
    assert.equal(summary.latestInputTokens, 3097)
    assert.equal(summary.latestCacheReadTokens, 37984)
    assert.equal(summary.realContextTokens, 41081)
    assert.equal(summary.cumulativeOutputTokens, 3492)

    const { report, latestStepUsage } = await buildAgyContextReport({
      sessionID: "ses_test_123",
      modelId: "gemini-4-hydrogen",
      variant: "medium",
      conversationId: convId,
      homeDir: tmpHome,
      quotaGroups: [
        {
          name: "Gemini Models",
          buckets: [
            {
              id: "gemini-weekly",
              name: "Weekly Limit Remaining",
              window: "weekly",
              remainingFraction: 0.63,
              resetTime: "2026-11-21T15:23:01Z",
            },
          ],
        },
      ],
    })

    assert.equal(latestStepUsage?.realContextTokens, 41081)
    assert.doesNotMatch(report, /<!--/)
    assert.match(report, /Antigravity \(agy\) Context Analysis/)
    assert.match(report, /41\.1K \/ 1M \(4\.1%\)/)
    assert.match(report, /41,081 tokens \(3,097 uncached \+ 37,984 cached, 92\.5% hit\)/)
    assert.match(report, /agy --conversation 7b9f0225-07e5-45e5-bc5a-39348c35e5cb/)
    assert.match(report, /Gemini Models/)

    const cacheDir = path.join(tmpHome, ".gemini", "antigravity-cli", "cache")
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(
      path.join(cacheDir, "conversation_metadata.json"),
      JSON.stringify({
        conversations: {
          [convId]: {
            last_modified_time: "2026-11-16T03:00:00Z",
            summary: {
              ID: convId,
              WorkspaceURIs: ["file:///Users/tester/my-workspace"],
            },
          },
        },
      }),
      "utf8",
    )

    const autoResolved = await buildAgyContextReport({
      sessionID: "ses_new_session",
      modelId: "gemini-4-argon",
      variant: "low",
      workspaceDir: "/Users/tester/my-workspace",
      homeDir: tmpHome,
      quotaGroups: [],
    })
    assert.equal(autoResolved.resolvedConversationId, convId)
    assert.equal(autoResolved.latestStepUsage?.realContextTokens, 41081)
    assert.match(autoResolved.report, /latest workspace conversation/)
  } finally {
    rmSync(tmpHome, { recursive: true, force: true })
  }
})

test("parseAgyModelsOutput and buildAgyUsageReport initialize plan models and quota badges", async () => {
  const rawModels = [
    "gemini-4-argon-medium\tGemini 4 Argon (Medium)",
    "gemini-4-argon-high\tGemini 4 Argon (High)",
    "gemini-4-argon-low\tGemini 4 Argon (Low)",
    "gemini-4-hydrogen-high\tGemini 4 Hydrogen (High)",
    "gemini-4-hydrogen-xhigh\tGemini 4 Hydrogen (XHigh)",
    "gemini-4-hydrogen-medium\tGemini 4 Hydrogen (Medium)",
    "gemini-4-hydrogen-low\tGemini 4 Hydrogen (Low)",
    "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
  ].join("\n")

  const specs = parseAgyModelsOutput(rawModels)
  const hydrogen = specs.find((s) => s.id === "gemini-4-hydrogen")
  const argon = specs.find((s) => s.id === "gemini-4-argon")
  const gpt = specs.find((s) => s.id === "gpt-oss-120b-medium")

  assert.ok(hydrogen)
  assert.deepEqual(hydrogen.variants, ["low", "medium", "high", "xhigh"])
  assert.equal(hydrogen.defaultVariant, "medium")

  assert.ok(argon)
  assert.deepEqual(argon.variants, ["low", "medium", "high"])
  assert.equal(argon.defaultVariant, "high")

  assert.ok(gpt)
  assert.equal(gpt.variants, undefined)

  const quotaGroups = [
    {
      name: "Gemini Models",
      buckets: [
        { id: "gemini-weekly", name: "Weekly", window: "weekly", remainingFraction: 0.62 },
        { id: "gemini-5h", name: "5h", window: "5h", remainingFraction: 0 },
      ],
    },
    {
      name: "Gemini 4 Argon",
      buckets: [
        { id: "gemini-argon-wtu-weekly", name: "Weekly", window: "weekly", remainingFraction: 0.34 },
      ],
    },
  ]

  assert.match(detectPlanTier(quotaGroups), /Pro Plan/)
  const hStatus = evaluateModelQuotaStatus(hydrogen, quotaGroups)
  assert.equal(hStatus.available, false)
  assert.match(hStatus.displayName, /0% limit/)

  const aStatus = evaluateModelQuotaStatus(argon, quotaGroups)
  assert.equal(aStatus.available, true)
  assert.match(aStatus.displayName, /34% wk/)

  const { report } = await buildAgyUsageReport({
    sessionID: "ses_1",
    modelId: "gemini-4-argon",
    variant: "low",
    agyBin: "agy",
    workspaceDir: "/tmp",
    env: {},
    preferredDefaultModel: "gemini-4-hydrogen",
    catalog: {
      models: specs,
      quotaGroups,
      remainingCredits: 0,
      planTier: detectPlanTier(quotaGroups),
      recommendedDefaultModel: "gemini-4-argon",
    },
  })

  assert.match(report, /Antigravity \(agy\) Plan & Quota Usage/)
  assert.match(report, /Pro Plan/)
  assert.match(report, /Initialized Plan Models/)
})
