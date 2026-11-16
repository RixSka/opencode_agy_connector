import { MAX_OUTPUT_BYTES, type AgyErrorPayload, type AgyJsonResult, type AgyUsage, type ParsedOutput, type V3Usage } from "./types.ts"

/** Strip ANSI escape sequences and normalize CRLF line endings. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r\n/g, "\n")
}

/** Cap text to a UTF-8 byte budget while preserving valid boundaries where possible. */
export function capBytes(text: string, maxBytes: number = MAX_OUTPUT_BYTES): string {
  const buf = Buffer.from(text, "utf8")
  if (buf.byteLength <= maxBytes) return text
  const notice = `\n\n...[truncated output to ${Math.round(maxBytes / 1024)} KB cap]`
  const noticeBytes = Buffer.byteLength(notice, "utf8")
  const sliceLen = Math.max(0, maxBytes - noticeBytes)
  return buf.subarray(0, sliceLen).toString("utf8") + notice
}

/** Inspect a single cleaned line from `agy` stdout/stderr for control diagnostics. */
export function inspectControlLine(
  line: string,
): { agyError?: AgyErrorPayload; permissionBlocked?: string } | undefined {
  if (line.startsWith("AGY_ERROR:")) {
    const payload = line.slice("AGY_ERROR:".length).trim()
    try {
      return { agyError: JSON.parse(payload) as AgyErrorPayload }
    } catch {
      return { agyError: { short_error: payload } }
    }
  }
  if (line.includes("no output produced") && line.includes("permission that headless mode cannot prompt for")) {
    return { permissionBlocked: line }
  }
  return undefined
}

/** Parse structured JSON, `AGY_ERROR:` payloads, and permission denials from buffered output. */
export function parseAgyOutput(rawStdout: string, rawStderr: string): ParsedOutput {
  const cleanedStdout = stripAnsi(rawStdout).trim()
  const cleanedStderr = stripAnsi(rawStderr).trim()
  const combinedLines = `${cleanedStdout}\n${cleanedStderr}`.split("\n")

  let result: AgyJsonResult | undefined
  let agyError: AgyErrorPayload | undefined
  let permissionBlocked: string | undefined

  for (const rawLine of combinedLines) {
    const line = rawLine.trim()
    if (!line) continue

    const ctrl = inspectControlLine(line)
    if (ctrl?.agyError) {
      agyError = ctrl.agyError
      continue
    }
    if (ctrl?.permissionBlocked) {
      permissionBlocked = ctrl.permissionBlocked
      continue
    }

    if (line.startsWith("{") && line.endsWith("}")) {
      try {
        const parsed = JSON.parse(line) as AgyJsonResult
        if (typeof parsed === "object" && parsed !== null && ("status" in parsed || "conversation_id" in parsed)) {
          result = parsed
        }
      } catch {
        // Ignore non-JSON lines or warnings mixed into output.
      }
    }
  }

  return { result, agyError, permissionBlocked, cleanedStdout, cleanedStderr }
}

/** Build a structured failure message preserving `conversation_id` when available. */
export function buildFailureMessage(
  code: number | null,
  signalName: NodeJS.Signals | null,
  timedOut: boolean,
  parsed: ParsedOutput,
): string {
  const parts: string[] = []
  const reason = parsed.agyError?.reason ?? parsed.result?.finished_reason
  const status = parsed.agyError?.status ?? parsed.result?.status

  if (parsed.permissionBlocked) {
    parts.push(`agy headless permission auto-denied (exit ${code ?? "null"}): ${parsed.permissionBlocked}`)
  } else if (timedOut) {
    parts.push("agy exceeded the hard process timeout and was terminated.")
  } else {
    const detail = parsed.agyError?.short_error ?? parsed.result?.error ?? "agy execution failed"
    parts.push(
      `agy failed (exit=${code ?? "null"}${signalName ? `, signal=${signalName}` : ""}${status ? `, status=${status}` : ""}${reason ? `, reason=${reason}` : ""}): ${detail}`,
    )
  }

  if (parsed.result?.conversation_id) {
    parts.push(`conversation_id: ${parsed.result.conversation_id} (can be resumed via --conversation)`)
  }

  if (parsed.result?.response?.trim()) {
    parts.push(`Partial response:\n${parsed.result.response.trim()}`)
  } else if (parsed.cleanedStderr) {
    parts.push(`stderr:\n${parsed.cleanedStderr}`)
  } else if (parsed.cleanedStdout && !parsed.result) {
    parts.push(`output:\n${parsed.cleanedStdout}`)
  }

  return capBytes(parts.join("\n\n"))
}

/** Convert an Antigravity CLI usage object into AI SDK v3 token usage counters. */
export function toV3Usage(usage?: AgyUsage): V3Usage {
  return {
    inputTokens: {
      total: usage?.input_tokens ?? 0,
      noCache: undefined,
      cacheRead: usage?.cache_read_tokens ?? 0,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: usage?.output_tokens ?? 0,
      text: undefined,
      reasoning: usage?.thinking_tokens ?? 0,
    },
  }
}
