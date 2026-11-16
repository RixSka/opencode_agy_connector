import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  MAX_HISTORY_ENTRY_CHARS,
  MAX_PROMPT_CHARS,
  SKIP_INSTRUCTION_KEYS,
  type AgyMeta,
} from "./types.ts"

/** Extract non-harness instructions (`AGENTS.md`, agent role, plugin memory) from OpenCode system parts. */
export function extractRelevantInstructions(systemParts: readonly unknown[]): string {
  const kept: string[] = []

  for (const part of systemParts) {
    if (!part || typeof part !== "object") continue
    const record = part as Record<string, unknown>
    const meta = record.metadata as { experimental?: { instructions?: unknown } } | undefined
    const entries = meta?.experimental?.instructions

    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (!entry || typeof entry !== "object") continue
        const item = entry as { key?: unknown; text?: unknown }
        if (
          typeof item.text === "string" &&
          item.text.trim() &&
          typeof item.key === "string" &&
          !SKIP_INSTRUCTION_KEYS.has(item.key)
        ) {
          kept.push(item.text.trim())
        }
      }
      continue
    }

    const text = typeof record.text === "string" ? record.text.trim() : ""
    if (!text) continue
    if (
      text.startsWith("You are an AI agent running in OpenCode, a coding agent harness.") ||
      text.startsWith("# Your Model\n") ||
      text.includes("tools.opencode.session_move")
    ) {
      continue
    }
    kept.push(text)
  }

  return kept.join("\n\n").trim()
}

function extensionForMediaType(mediaType: string, filename?: string): string {
  if (filename) {
    const ext = path.extname(filename)
    if (ext) return ext
  }
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "application/pdf": ".pdf",
    "application/json": ".json",
    "text/plain": ".txt",
    "text/markdown": ".md",
  }
  return map[mediaType.toLowerCase()] ?? ".bin"
}

/** Stage inline or binary attachments into `TMPDIR` so Antigravity tools can inspect them. */
export function stageAttachmentPart(part: Record<string, unknown>): string {
  const mediaType = typeof part.mediaType === "string" ? part.mediaType : "application/octet-stream"
  const data = part.data
  const filename = typeof part.filename === "string" ? part.filename : undefined

  if (data instanceof URL) {
    return data.protocol === "file:"
      ? `[Attached file: ${fileURLToPath(data)} (${mediaType})]`
      : `[Attached URL: ${data.href} (${mediaType})]`
  }

  if (typeof data === "string" && (data.startsWith("http://") || data.startsWith("https://"))) {
    return `[Attached URL: ${data} (${mediaType})]`
  }

  try {
    const buf =
      data instanceof Uint8Array
        ? Buffer.from(data)
        : typeof data === "string"
          ? Buffer.from(data, "base64")
          : undefined
    if (!buf || buf.byteLength === 0) {
      return `[Attached file: ${filename ?? "attachment"} (${mediaType})]`
    }

    const dir = path.join(os.tmpdir(), "opencode-agy-attachments")
    mkdirSync(dir, { recursive: true })
    const hash = createHash("sha256").update(buf).digest("hex").slice(0, 12)
    const safeBase = (filename ? path.basename(filename) : "attachment").replace(/[^a-zA-Z0-9._-]/g, "_")
    const ext = extensionForMediaType(mediaType, safeBase)
    const fileName = safeBase.includes(".") ? `${hash}-${safeBase}` : `${hash}-${safeBase}${ext}`
    const targetPath = path.join(dir, fileName)
    writeFileSync(targetPath, buf)
    return `[Attached file staged for inspection via view_file: ${targetPath} (${mediaType})]`
  } catch {
    return `[Attached file: ${filename ?? "attachment"} (${mediaType})]`
  }
}

/** Render a LanguageModelV3 message content value into plain prompt text. */
export function renderMessageContent(content: unknown, includeAttachments: boolean): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  const chunks: string[] = []
  for (const rawPart of content) {
    if (!rawPart || typeof rawPart !== "object") continue
    const part = rawPart as Record<string, unknown>
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      chunks.push(part.text)
    } else if (part.type === "file" && includeAttachments) {
      chunks.push(stageAttachmentPart(part))
    } else if (part.type === "tool-call" && typeof part.toolName === "string") {
      chunks.push(`[Used tool ${part.toolName}]`)
    }
  }
  return chunks.join("\n").trim()
}

function findLastAssistantIndex(messages: readonly Record<string, unknown>[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") return i
  }
  return -1
}

/** Serialize an AI SDK prompt into a self-contained or resumed `agy -p` input string. */
export function buildProviderPrompt(params: {
  readonly prompt: readonly unknown[]
  readonly resumingConversation: boolean
  readonly meta?: AgyMeta
  readonly agentChanged: boolean
  readonly readOnly: boolean
}): string {
  const { prompt, resumingConversation, meta, agentChanged, readOnly } = params
  const messages = prompt.filter(
    (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && (entry as Record<string, unknown>).role !== "system"),
  )

  const lastAssistantIdx = findLastAssistantIndex(messages)
  const trailingUsers = messages.slice(lastAssistantIdx + 1)

  if (resumingConversation) {
    const latestText = trailingUsers
      .map((m) => renderMessageContent(m.content, true))
      .filter(Boolean)
      .join("\n\n")
      .trim()
    if (!latestText) return ""

    const prefixes: string[] = []
    if (agentChanged && meta?.agent) {
      prefixes.push(`[OpenCode active agent switched to "${meta.agent}".]`)
    }
    if (readOnly) {
      prefixes.push(
        `[Read-only mode active for OpenCode agent "${meta?.agent ?? "plan"}": do NOT edit, create, or delete files, and return your full response directly as text.]`,
      )
    }
    return [...prefixes, latestText].join("\n\n").slice(0, MAX_PROMPT_CHARS)
  }

  const sections: string[] = []
  const instructions = meta?.instructions?.trim() || ""
  if (instructions) {
    sections.push(`<workspace_and_role_instructions>\n${instructions}\n</workspace_and_role_instructions>`)
  } else {
    const fallbackSys = prompt
      .filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry && typeof entry === "object" && (entry as Record<string, unknown>).role === "system"),
      )
      .map((m) => (typeof m.content === "string" ? m.content.trim() : ""))
      .filter(
        (t) =>
          Boolean(t) &&
          !t.startsWith("You are an AI agent running in OpenCode, a coding agent harness.") &&
          !t.includes("tools.opencode.session_move"),
      )
      .join("\n\n")
    if (fallbackSys) {
      sections.push(`<system_instructions>\n${fallbackSys.slice(0, 12_000)}\n</system_instructions>`)
    }
  }

  if (readOnly) {
    sections.push(
      `<read_only_constraint>\nYou are operating under OpenCode agent "${meta?.agent ?? "plan"}". Operate STRICTLY READ-ONLY: do NOT create, edit, or delete workspace files or brain artifact files, and provide your complete answer or plan directly in your text response.\n</read_only_constraint>`,
    )
  }

  const priorMessages = lastAssistantIdx >= 0 ? messages.slice(0, lastAssistantIdx + 1) : []
  if (priorMessages.length > 0) {
    const historyLines: string[] = []
    for (const msg of priorMessages.slice(-12)) {
      const rendered = renderMessageContent(msg.content, false)
      if (!rendered) continue
      const clipped =
        rendered.length > MAX_HISTORY_ENTRY_CHARS
          ? `${rendered.slice(0, MAX_HISTORY_ENTRY_CHARS)}...`
          : rendered
      historyLines.push(`[${String(msg.role ?? "user")}]: ${clipped}`)
    }
    if (historyLines.length > 0) {
      sections.push(`<prior_conversation>\n${historyLines.join("\n\n")}\n</prior_conversation>`)
    }
  }

  const currentText = trailingUsers
    .map((m) => renderMessageContent(m.content, true))
    .filter(Boolean)
    .join("\n\n")
    .trim()

  if (!currentText && sections.length === 0) return ""
  if (currentText) sections.push(currentText)

  return sections.join("\n\n").slice(0, MAX_PROMPT_CHARS)
}

/** Build an instant OpenCode session title without spawning an extra CLI turn. */
export function buildInstantTitle(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg || typeof msg !== "object") continue
    const text = renderMessageContent((msg as Record<string, unknown>).content, false)
    if (!text) continue
    const match = /<message>\s*([\s\S]*?)\s*<\/message>/i.exec(text)
    const raw = (match?.[1] ?? text).replace(/\s+/g, " ").trim()
    if (raw) {
      return raw.length > 60 ? `${raw.slice(0, 57)}...` : raw
    }
  }
  return "Antigravity Session"
}
