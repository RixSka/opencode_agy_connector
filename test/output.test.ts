import assert from "node:assert/strict"
import test from "node:test"
import { buildFailureMessage, capBytes, parseAgyOutput, stripAnsi, toV3Usage } from "../src/output.ts"

test("stripAnsi removes terminal color codes and normalizes CRLF", () => {
  const input = "\x1B[31merror\x1B[0m\r\nline 2"
  assert.equal(stripAnsi(input), "error\nline 2")
})

test("capBytes truncates oversized UTF-8 strings with clear notice", () => {
  const large = "a".repeat(2048)
  const capped = capBytes(large, 256)
  assert.ok(Buffer.byteLength(capped, "utf8") <= 256)
  assert.match(capped, /truncated output/)
})

test("parseAgyOutput extracts JSON result, AGY_ERROR, and headless permission denial", () => {
  const stdout = [
    "some debug noise",
    JSON.stringify({
      conversation_id: "conv-123",
      status: "ERROR",
      error: "Write blocked",
      finished_reason: "PERMISSION_DENIED",
    }),
  ].join("\n")

  const stderr = [
    'AGY_ERROR: {"short_error":"Quota exhausted","status":"RESOURCE_EXHAUSTED","retryable":false,"reason":"RATE_LIMIT"}',
    'jetski: no output produced — a tool required the "write_file" permission that headless mode cannot prompt for',
  ].join("\n")

  const parsed = parseAgyOutput(stdout, stderr)
  assert.equal(parsed.result?.conversation_id, "conv-123")
  assert.equal(parsed.agyError?.short_error, "Quota exhausted")
  assert.match(parsed.permissionBlocked ?? "", /permission that headless mode cannot prompt for/)

  const failure = buildFailureMessage(1, null, false, parsed)
  assert.match(failure, /agy headless permission auto-denied/)
  assert.match(failure, /conversation_id: conv-123/)
})

test("toV3Usage maps agy usage fields to AI SDK v3 format", () => {
  const mapped = toV3Usage({
    input_tokens: 1200,
    cache_read_tokens: 400,
    output_tokens: 250,
    thinking_tokens: 80,
  })

  assert.equal(mapped.inputTokens.noCache, 1200)
  assert.equal(mapped.inputTokens.cacheRead, 400)
  assert.equal(mapped.inputTokens.total, 1600)
  assert.equal(mapped.inputTokens.cacheWrite, 0)
  assert.equal(mapped.outputTokens.total, 250)
  assert.equal(mapped.outputTokens.text, 170)
  assert.equal(mapped.outputTokens.reasoning, 80)
})
