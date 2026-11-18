import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { buildStreamArgs } from "../src/provider.ts"
import { getBundledSkillPath, parseSkillMarkdown } from "../src/skill-doc.ts"
import { parseConnectorConfig, resolveProviderCliModel } from "../src/types.ts"

test("bundled skills/agy/SKILL.md parses frontmatter and markdown body cleanly", () => {
  const raw = readFileSync(getBundledSkillPath(), "utf8")
  const parsed = parseSkillMarkdown(raw)
  assert.equal(parsed.id, "agy")
  assert.equal(parsed.name, "agy")
  assert.match(parsed.description, /Antigravity CLI/)
  assert.match(parsed.content, /# Antigravity CLI/)
})

test("parseConnectorConfig normalizes options with safe fallbacks", () => {
  const defaults = parseConnectorConfig(undefined)
  assert.equal(defaults.defaultModel, "gemini-4-hydrogen")
  assert.equal(defaults.defaultVariant, "medium")
  assert.equal(defaults.defaultToolModel, "gemini-4-hydrogen-medium")
  assert.equal(defaults.timeoutSeconds, 600)
  assert.equal(defaults.swarmTimeoutSeconds, 0)
  assert.equal(defaults.mode, "accept-edits")
  assert.equal(defaults.allowAllTools, false)
  assert.equal(defaults.allowSwarm, true)
  assert.equal(defaults.enableSlashCommands, false)
  assert.equal(defaults.registerProvider, true)
  assert.equal(defaults.registerTool, true)
  assert.equal(defaults.registerCommand, true)
  assert.equal(defaults.registerSkill, true)

  const custom = parseConnectorConfig({
    binaryPath: "/opt/bin/agy",
    defaultModel: "gemini-3.8-flash",
    defaultVariant: "low",
    timeoutSeconds: 120,
    swarmTimeoutSeconds: 900,
    mode: "auto",
    allowAllTools: true,
    allowSwarm: false,
    enableSlashCommands: true,
    readOnlyAgents: ["plan", "audit"],
    registerTool: false,
  })
  assert.equal(custom.binaryPath, "/opt/bin/agy")
  assert.equal(custom.defaultModel, "gemini-3.8-flash")
  assert.equal(custom.defaultVariant, "low")
  assert.equal(custom.defaultToolModel, "gemini-3.8-flash-low")
  assert.equal(custom.timeoutSeconds, 120)
  assert.equal(custom.swarmTimeoutSeconds, 900)
  assert.equal(custom.mode, "auto")
  assert.equal(custom.allowAllTools, true)
  assert.equal(custom.allowSwarm, false)
  assert.equal(custom.enableSlashCommands, true)
  assert.equal(custom.readOnlyAgents.has("audit"), true)
  assert.equal(custom.readOnlyAgents.has("reviewer"), false)
  assert.equal(custom.registerTool, false)
})

test("resolveProviderCliModel maps variants and single-variant models accurately", () => {
  assert.equal(resolveProviderCliModel("gemini-4-hydrogen", "high"), "gemini-4-hydrogen-high")
  assert.equal(resolveProviderCliModel("gemini-4-hydrogen"), "gemini-4-hydrogen-medium")
  assert.equal(resolveProviderCliModel("gemini-pro-orchestrator-g1-pro", "high"), "gemini-pro-orchestrator-g1-pro")
  assert.equal(resolveProviderCliModel("gpt-oss-120b-medium"), "gpt-oss-120b-medium")
})

test("buildStreamArgs enables slash commands for swarm turns and disables otherwise", () => {
  const normalArgs = buildStreamArgs({
    promptText: "Refactor module",
    cliModel: "gemini-4-hydrogen-medium",
    timeoutSeconds: 600,
    readOnly: false,
    mode: "accept-edits",
    allowAllTools: false,
    enableSlashCommands: false,
  })
  assert.ok(normalArgs.includes("--disable-slash-commands"))
  assert.ok(normalArgs.includes("600s"))

  const swarmArgs = buildStreamArgs({
    promptText: "/swarm Split tasks",
    cliModel: "gemini-4-hydrogen-xhigh",
    timeoutSeconds: 0,
    readOnly: false,
    mode: "accept-edits",
    allowAllTools: true,
    enableSlashCommands: true,
  })
  assert.equal(swarmArgs.includes("--disable-slash-commands"), false)
  assert.ok(swarmArgs.includes("0s"))
  assert.ok(swarmArgs.includes("--dangerously-skip-permissions"))
})
