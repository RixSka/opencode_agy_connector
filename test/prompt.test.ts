import assert from "node:assert/strict"
import test from "node:test"
import { buildInstantTitle, buildProviderPrompt, extractRelevantInstructions, renderMessageContent } from "../src/prompt.ts"

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
