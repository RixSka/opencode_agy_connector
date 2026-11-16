import { readFileSync } from "node:fs"
import { Skill, type Plugin } from "@opencode/plugin"
import {
  buildAgyContextReport,
  enqueuePendingContextRequest,
  enqueuePendingUsageRequest,
} from "./context.ts"
import { buildSanitizedEnv, resolveAgyBinary } from "./env.ts"
import { getBundledSkillPath, parseSkillMarkdown } from "./skill-doc.ts"
import { PROVIDER_ID, type AgyConnectorConfig } from "./types.ts"

const FALLBACK_SKILL_CONTENT = `# Antigravity CLI (\`agy\`) Delegation Skill

Delegate heavy, self-contained coding, refactoring, test generation, PDF/multimodal file parsing, or deep analysis tasks to the headless Antigravity CLI (\`agy\`) running \`gemini-4-hydrogen-medium\` by default.

Prefer calling the registered \`agy\` OpenCode tool when available, or switch directly to \`agy/*\` models via \`/models\` or \`/agy <task>\`.
`

/** Register the bundled `@agy` skill and `/agy` direct-switch command when enabled. */
export async function registerPluginAssets(
  ctx: Plugin.Context,
  config: AgyConnectorConfig,
): Promise<void> {
  if (config.registerSkill) {
    const skillPath = getBundledSkillPath()
    let rawMarkdown = ""
    try {
      rawMarkdown = readFileSync(skillPath, "utf8")
    } catch {
      rawMarkdown = ""
    }

    const parsed = rawMarkdown
      ? parseSkillMarkdown(rawMarkdown, "agy")
      : {
          id: "agy",
          name: "agy",
          description:
            "Delegate scoped heavy coding, refactoring, test generation, or deep analysis tasks to Antigravity (agy) using Gemini 4 Hydrogen medium.",
          content: FALLBACK_SKILL_CONTENT,
        }

    await ctx.skill.transform((editor) => {
      if (editor.get(parsed.id)) return
      editor.add({
        id: Skill.ID.make(parsed.id),
        name: Skill.Name.make(parsed.name),
        description: parsed.description,
        path: Skill.Info.fields.path.make(skillPath),
        content: parsed.content,
      })
    })
  }

  if (config.registerCommand && config.registerProvider) {
    const variantSuffix = config.defaultVariant ? `#${config.defaultVariant}` : ""
    const modelLabel = `${PROVIDER_ID}/${config.defaultModel}${variantSuffix}`

    await ctx.command.transform((editor) => {
      editor.add({
        name: "agy",
        description: `Run a task directly on Antigravity (${modelLabel}) without another model`,
        execute: async ({ sessionID, prompt, delivery }) => {
          await ctx.session.switchModel({
            sessionID,
            model: {
              providerID: PROVIDER_ID,
              id: config.defaultModel,
              ...(config.defaultVariant ? { variant: config.defaultVariant } : {}),
            },
          })

          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
          })
        },
      })

      editor.add({
        name: "context",
        description: "Show real Antigravity (agy) context window, step-by-step tokens, tool breakdown, and quota",
        execute: async ({ sessionID, prompt, delivery }) => {
          const session = await ctx.session.get({ sessionID })
          const rawArg = (prompt.text ?? "").replace(/^\/(?:agy[-_:])?context\b/i, "").trim()

          if (session.model?.providerID === PROVIDER_ID) {
            enqueuePendingContextRequest(sessionID, rawArg || undefined)
            await ctx.session.prompt({
              ...prompt,
              text: rawArg ? `/context ${rawArg}` : "/context",
              sessionID,
              delivery,
            })
            return
          }

          const storedConv = await ctx.storage.get(`agy:conv:${sessionID}`)
          const convId = rawArg || (typeof storedConv === "string" && storedConv ? storedConv : undefined)
          const env = buildSanitizedEnv()
          const agyBin = resolveAgyBinary(config.binaryPath, env)
          const { report } = await buildAgyContextReport({
            sessionID,
            providerId: session.model?.providerID ?? PROVIDER_ID,
            modelId: session.model?.id ?? config.defaultModel,
            variant: session.model?.variant ?? config.defaultVariant,
            conversationId: convId,
            agyBin,
            workspaceDir: ctx.location.directory,
            env,
          })

          await ctx.session.synthetic({
            sessionID,
            text: report,
            description: "/context",
            resume: false,
          })
        },
      })

      editor.add({
        name: "usage",
        description: "Show Antigravity (agy) plan tier, quota buckets, reset timers, and initialized models (agy/* only)",
        execute: async ({ sessionID, prompt, delivery }) => {
          const session = await ctx.session.get({ sessionID })
          if (session.model?.providerID === PROVIDER_ID) {
            enqueuePendingUsageRequest(sessionID)
            await ctx.session.prompt({
              ...prompt,
              text: "/usage",
              sessionID,
              delivery,
            })
            return
          }

          await ctx.session.prompt({
            ...prompt,
            sessionID,
            delivery,
          })
        },
      })
    })
  }
}
