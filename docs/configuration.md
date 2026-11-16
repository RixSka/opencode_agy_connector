# Configuration Guide

## 1. Provider Policy (`policies`)

OpenCode evaluates `provider.use` policy statements in order; later matching rules override earlier ones.

### Antigravity Only (Zero Other Models)

Add to `~/.config/opencode/opencode.jsonc` or a repository's `.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "agy/gemini-4-hydrogen#medium",
  "policies": [
    { "action": "provider.use", "resource": "*", "effect": "deny" },
    { "action": "provider.use", "resource": "agy", "effect": "allow" }
  ]
}
```

If you previously configured `"agents"` entries pointing to another provider (for example `claude-agent/opus`), update or remove those per-agent `"model"` overrides so every agent inherits `agy/*`.

### Hybrid Setup (`claude-agent` + `agy`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "claude-agent/sonnet",
  "policies": [
    { "action": "provider.use", "resource": "*", "effect": "deny" },
    { "action": "provider.use", "resource": "claude-agent", "effect": "allow" },
    { "action": "provider.use", "resource": "agy", "effect": "allow" }
  ]
}
```

Even when another default provider hits a quota limit or is unavailable, `agy/*` stays reachable via `/models`, `/agy <task>`, `opencode mini -m agy/gemini-4-hydrogen#medium`, and `opencode run -m agy/gemini-4-hydrogen#medium "<prompt>"`.

---

## 2. Supported `agy/*` Models & Variants

| OpenCode Model ID | Variants (`#variant`) | Mapped CLI Model | Default Effort |
| --- | --- | --- | --- |
| `agy/gemini-4-hydrogen` | `low`, `medium`, `high`, `xhigh` | `gemini-4-hydrogen-{low,medium,high,xhigh}` | `medium` |
| `agy/gemini-4-argon` | `low`, `medium`, `high` | `gemini-4-argon-{low,medium,high}` | `high` |
| `agy/gemini-3.8-flash` | `low`, `medium`, `high` | `gemini-3.8-flash-{low,medium,high}` | `medium` |
| `agy/gemini-pro-orchestrator-g1-pro` | — | `gemini-pro-orchestrator-g1-pro` | — |
| `agy/claude-opus-5-5` | `low`, `medium`, `high` | `claude-opus-5-5-{low,medium,high}` | `high` |
| `agy/claude-sonnet-5-5` | `low`, `medium`, `high` | `claude-sonnet-5-5-{low,medium,high}` | `high` |
| `agy/gpt-oss-120b-medium` | — | `gpt-oss-120b-medium` | — |

Verify installed CLI models on your machine anytime with:

```bash
agy models
```

---

## 3. Plugin Options

Pass plugin options in `opencode.jsonc` using the object plugin syntax:

```jsonc
{
  "plugins": [
    {
      "package": "github:RixSka/opencode_agy_connector",
      "options": {
        "binaryPath": "/Users/your-user/.local/bin/agy",
        "defaultModel": "gemini-4-hydrogen",
        "defaultVariant": "medium",
        "defaultToolModel": "gemini-4-hydrogen-medium",
        "timeoutSeconds": 600,
        "allowAllTools": false,
        "readOnlyAgents": ["plan", "reviewer", "explore"],
        "registerProvider": true,
        "registerTool": true,
        "registerCommand": true,
        "registerSkill": true
      }
    }
  ]
}
```

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `binaryPath` | `string` | `undefined` | Explicit path to the `agy` binary. Overrides `AGY_BIN` and `PATH` resolution. |
| `defaultModel` | `string` | `"gemini-4-hydrogen"` | Default `agy/*` model ID selected when `/agy` runs. |
| `defaultVariant` | `string` | `"medium"` | Effort variant selected by `/agy` when supported by `defaultModel`. |
| `defaultToolModel` | `string` | Derived (`gemini-4-hydrogen-medium`) | Default CLI model passed to `agy -p` by the `agy` delegation tool. |
| `timeoutSeconds` | `number` | `600` | Print timeout in seconds (`0` disables `--print-timeout`). |
| `allowAllTools` | `boolean` | `false` | Pass `--dangerously-skip-permissions` on primary non-read-only `agy/*` runs so headless shell commands outside `settings.json` are not auto-denied. Ignored on `readOnlyAgents` and background compaction/generate turns. |
| `readOnlyAgents` | `string[]` | `["plan", "reviewer", "explore"]` | OpenCode agent IDs constrained to read-only execution (`--mode accept-edits` omitted + read-only prompt guardrail). |
| `registerProvider` | `boolean` | `true` | Register the native `agy/*` AI SDK provider and session hooks. |
| `registerTool` | `boolean` | `true` | Register the `agy` delegation tool for other models/sessions. |
| `registerCommand` | `boolean` | `true` | Register the built-in `/agy` slash command. Set to `false` if using a custom `commands/agy.md` file. |
| `registerSkill` | `boolean` | `true` | Register the bundled `agy` skill unless an existing global/project `agy` skill already overrides it. |

---

## 4. Customizing `/agy` or `@agy`

- **Skill override:** Place a custom `SKILL.md` in `~/.config/opencode/skills/agy/SKILL.md` or `.opencode/skills/agy/SKILL.md`. The plugin preserves existing `agy` skills without overwriting them.
- **Markdown command template:** If you want to customize `/agy` via Markdown instead of the programmatic command, copy [`commands/agy.md`](../commands/agy.md) to `~/.config/opencode/commands/agy.md` and set `"registerCommand": false` in plugin options.
