import path from "node:path"
import { fileURLToPath } from "node:url"

export interface ParsedSkillDocument {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly content: string
}

/** Parse YAML frontmatter and body from a bundled `SKILL.md` markdown file. */
export function parseSkillMarkdown(rawMarkdown: string, fallbackId: string = "agy"): ParsedSkillDocument {
  const normalized = rawMarkdown.replace(/\r\n/g, "\n")
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized)
  if (!match) {
    return {
      id: fallbackId,
      name: fallbackId,
      description: "Delegate scoped tasks to Antigravity (agy).",
      content: normalized.trim(),
    }
  }

  const frontmatter = match[1] ?? ""
  const body = (match[2] ?? "").trim()
  let name = fallbackId
  let description = "Delegate scoped tasks to Antigravity (agy)."

  for (const line of frontmatter.split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "")
    if (key === "name" && val) name = val
    if (key === "description" && val) description = val
  }

  return {
    id: name || fallbackId,
    name: name || fallbackId,
    description,
    content: body,
  }
}

/** Resolve the bundled `skills/agy/SKILL.md` path relative to this plugin package. */
export function getBundledSkillPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url))
  return path.resolve(currentDir, "..", "skills", "agy", "SKILL.md")
}
