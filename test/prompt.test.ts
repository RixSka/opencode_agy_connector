import assert from "node:assert/strict"
import test from "node:test"
import {
  buildInstantTitle,
  buildProviderPrompt,
  detectContextCommandInPrompt,
  detectUsageCommandInPrompt,
  extractRelevantInstructions,
  parseContextCommand,
  parseUsageCommand,
  renderMessageContent,
} from "../src/prompt.ts"
import { CONTEXT_REPORT_MARKER } from "../src/types.ts"

test("extractRelevantInstructions keeps custom agent prompts and project instructions while skipping internal harness blocks", () => {
  const instructions = extractRelevantInstructions([
    { text: "Custom reviewer prompt" },
    { text: "You are an AI agent running in OpenCode, a coding agent harness.\nDetails..." },
    {
      metadata: {
        experimental: {
          instructions: [
            { key: "core/environment", text: "OS: macOS" },
            { key: "core/instructions", text: "Always run tests before claiming completion." },
          ],
        },
      },
    },
  ])

  assert.match(instructions, /Custom reviewer prompt/)
  assert.match(instructions, /Always run tests before claiming completion\./)
  assert.doesNotMatch(instructions, /OS: macOS/)
  assert.doesNotMatch(instructions, /coding agent harness/)
})

test("buildProviderPrompt wraps initial context and read-only constraints cleanly", () => {
  const text = buildProviderPrompt({
    prompt: [
      { role: "user", content: [{ type: "text", text: "Audit authentication flow" }] },
    ],
    resumingConversation: false,
    meta: {
      sessionID: "ses_123",
      agent: "reviewer",
      kind: "primary",
      instructions: "Follow strict security checks.",
    },
    agentChanged: false,
    readOnly: true,
  })

  assert.match(text, /<workspace_and_role_instructions>\nFollow strict security checks\./)
  assert.match(text, /<read_only_constraint>[\s\S]*reviewer[\s\S]*STRICTLY READ-ONLY/)
  assert.match(text, /Audit authentication flow/)
})

test("buildProviderPrompt sends only delta turns when resuming an active agy conversation", () => {
  const text = buildProviderPrompt({
    prompt: [
      { role: "user", content: "Remember CODE-99" },
      { role: "assistant", content: "Stored CODE-99." },
      { role: "user", content: "Repeat the code." },
    ],
    resumingConversation: true,
    meta: {
      sessionID: "ses_123",
      agent: "build",
      kind: "primary",
      instructions: "Ignored when resuming",
    },
    agentChanged: true,
    readOnly: false,
  })

  assert.match(text, /\[OpenCode active agent switched to "build"\.\]/)
  assert.match(text, /Repeat the code\./)
  assert.doesNotMatch(text, /Remember CODE-99/)
  assert.doesNotMatch(text, /Ignored when resuming/)
})

test("buildInstantTitle extracts <message> tag or clips long text", () => {
  assert.equal(
    buildInstantTitle([{ role: "user", content: "<message>Fix login bug in middleware</message>" }]),
    "Fix login bug in middleware",
  )

  const long = buildInstantTitle([{ role: "user", content: "x".repeat(80) }])
  assert.equal(long.length, 60)
  assert.ok(long.endsWith("..."))
})

test("renderMessageContent renders text parts and tool call summaries", () => {
  const rendered = renderMessageContent(
    [
      { type: "text", text: "Inspecting file" },
      { type: "tool-call", toolName: "read_file" },
    ],
    false,
  )
  assert.equal(rendered, "Inspecting file\n[Used tool read_file]")
})

test("parseContextCommand and detectContextCommandInPrompt recognize /context commands", () => {
  assert.deepEqual(parseContextCommand("/context"), { matched: true })
  assert.deepEqual(
    parseContextCommand(
      "/context 7b9f0225-07e5-45e5-bc5a-39348c35e5cb\n\n<dcp-system-reminder>\nCRITICAL WARNING: MAX CONTEXT LIMIT REACHED\n</dcp-system-reminder>\n\n@5@",
    ),
    {
      matched: true,
      arg: "7b9f0225-07e5-45e5-bc5a-39348c35e5cb",
    },
  )
  assert.deepEqual(parseContextCommand("<message>/context 7b9f0225-07e5</message>"), {
    matched: true,
    arg: "7b9f0225-07e5",
  })
  assert.deepEqual(parseContextCommand("Explain /context"), { matched: false })

  const detected = detectContextCommandInPrompt([
    { role: "user", content: "Initial task" },
    { role: "assistant", content: "Done." },
    { role: "user", content: "<system-reminder>Mode changed</system-reminder>" },
    { role: "user", content: "/context" },
  ])
  assert.equal(detected.matched, true)

  assert.deepEqual(parseUsageCommand("/usage\n\n@3@"), { matched: true })
  assert.deepEqual(parseUsageCommand("/quota"), { matched: true })
  assert.equal(
    detectUsageCommandInPrompt([{ role: "user", content: "/usage\n\n@2@" }]).matched,
    true,
  )
})

test("buildProviderPrompt strips diagnostic /context turns and redundant compaction checkpoints", () => {
  const resumed = buildProviderPrompt({
    prompt: [
      { role: "user", content: "First prompt" },
      { role: "assistant", content: "First reply" },
      { role: "user", content: "/context" },
      { role: "assistant", content: `${CONTEXT_REPORT_MARKER}\nContext report body` },
      {
        role: "user",
        content: "<conversation-checkpoint>\nSummary of old turns\n</conversation-checkpoint>\n\nActual follow-up question",
      },
    ],
    resumingConversation: true,
    meta: { sessionID: "ses_1", agent: "build", kind: "primary", instructions: "" },
    agentChanged: false,
    readOnly: false,
  })

  assert.equal(resumed, "Actual follow-up question")
})
