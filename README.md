# opencode_agy_connector

OpenCode v2 connector plugin that registers **Antigravity (`agy`)** as a first-class native model provider (`agy/*`), bundles the **`/agy` command** and **`@agy` skill**, and provides the **`agy` delegation tool** — allowing you to run Antigravity inside OpenCode **with zero dependency on Claude or any other model provider**.

---

## Features

- **Standalone `agy/*` Model Provider:** Exposes 7 Antigravity model families and effort variants (`#low`, `#medium`, `#high`, `#xhigh`) natively inside OpenCode's model picker, `opencode mini -m`, and `opencode run -m`.
- **Direct `/agy` & `/swarm` Commands:** Programmatically registered `/agy <task>` switches straight to `agy/gemini-4-hydrogen#medium` (configurable), and `/swarm <task>` starts a native Antigravity multi-agent swarm (keeping slash-command expansion enabled and unbounded swarm timeouts by default) without sending an intermediate turn to another provider.
- **Direct `/context` & `/usage` Inspectors (`agy/*`):** Run `/context` to inspect the real Antigravity context window, visual category breakdown, step-by-step token trajectory from `transcript.jsonl`, and live `/usage` quota buckets; or run `/usage` on any `agy/*` model to inspect your detected Antigravity plan tier, quota pools, local reset countdowns, and dynamically initialized plan models (`agy models`).
- **Right-Sidebar Live Quota, Swarm & Subagents Widget (`./tui`):** Renders **Antigravity Quota** (progress bars, `%`, reset countdowns, `[↻ Refresh]`, `/agy-refresh`) plus live **Antigravity Swarm & Subagents** status in OpenCode's right sidebar (`sidebar.content`) — mirroring Antigravity's own telemetry (member/subagent status: `Active`/`Waiting`/`Done`/`Blocked · <tool>`/`Quota`/`Error`/`Killed`, model, current tool or thinking activity, step/token/post/unread counts, workspace mode, latest board post, and a clickable `[Board]` / `[Inspect]` / `/agy-swarm` inspector modal).
- **Bundled `@agy` Skill:** Automatically loads [`skills/agy/SKILL.md`](./skills/agy/SKILL.md) into OpenCode when no user-defined override is present.
- **Explicit `agy` Delegation Tool:** Lets non-Antigravity sessions offload heavy multi-file refactors, test generation, PDF inspection, or independent reviews to headless `agy -p`.
- **Streaming Tools & Session Continuity:** Streams NDJSON tool calls (`providerExecuted: true`), forwards `AGENTS.md` + active OpenCode agent role prompts, stages binary/file attachments, generates titles without spawning extra LLM calls, enforces read-only constraints on `plan`/`reviewer`/`explore`, and resumes multi-turn sessions via `--conversation`.
- **Configurable Plugin Options:** Override the `agy` binary path, default model/variant, timeout, read-only agent list, or toggle individual components via `opencode.jsonc`.

---

## Prerequisites

- **OpenCode v2** (`>= 2.3.0`)
- **Antigravity CLI (`agy`)** installed on `PATH` (or `~/.local/bin/agy`) and authenticated:
  ```bash
  agy --version
  agy models
  ```

---

## Installation

Install directly from GitHub (`github:RixSka/opencode_agy_connector`). If you fetch over SSH or from a private repository/fork, make sure your local Git credentials or SSH keys are configured (`gh auth login` or your SSH key).

### Option A — Install & Track Updates via OpenCode CLI (Recommended)

Install with `opencode plugin add` so OpenCode manages caching and updates automatically:

```bash
# Using GitHub shorthand (tracks default branch)
opencode plugin add github:RixSka/opencode_agy_connector

# Or pin to main explicitly over HTTPS / SSH
opencode plugin add git+https://github.com/RixSka/opencode_agy_connector.git#main
# opencode plugin add git+ssh://git@github.com/RixSka/opencode_agy_connector.git#main
```

Restart the OpenCode daemon after installing:

```bash
opencode service restart
```

### Option B — Configure in `opencode.jsonc`

Add the package (or local checkout path) to `~/.config/opencode/opencode.jsonc` or a project `.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "github:RixSka/opencode_agy_connector"
  ]
}
```

Or with explicit options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "github:RixSka/opencode_agy_connector",
      "options": {
        "defaultModel": "gemini-4-hydrogen",
        "defaultVariant": "medium",
        "timeoutSeconds": 600,
        "swarmTimeoutSeconds": 0,
        "mode": "accept-edits",
        "allowAllTools": false,
        "allowSwarm": true
      }
    }
  ]
}
```

For local development against your clone:

```jsonc
{
  "plugins": [
    "/path/to/opencode_plugins/opencode_agy_connector"
  ]
}
```

### Required Provider Policy (`policies`)

If your OpenCode config uses `"policies"` to deny `"*"`, remember to allow `"agy"`:

```jsonc
{
  "model": "agy/gemini-4-hydrogen#medium",
  "policies": [
    { "action": "provider.use", "resource": "*", "effect": "deny" },
    { "action": "provider.use", "resource": "agy", "effect": "allow" }
  ]
}
```

Verify available models and plugin status:

```bash
opencode models
opencode plugin list
```

---

## Updating in OpenCode

When new commits or tags are pushed to GitHub (unpinned specs such as `github:RixSka/opencode_agy_connector` or `#main`):

```bash
opencode plugin check
opencode plugin update
opencode service restart
```

To target only this plugin (using the configured package target, for example):

```bash
opencode plugin update github:RixSka/opencode_agy_connector
opencode service restart
```

*(If you pinned an immutable commit SHA or loaded a local checkout path in `"plugins"`, pull updates locally in Git and run `opencode service restart`.)*

---

## Using Antigravity Without Any Other Model

- **OpenCode Minimal Interactive TUI:**
  ```bash
  opencode mini -m agy/gemini-4-hydrogen#medium
  ```
- **Headless / Scripted OpenCode Run:**
  ```bash
  opencode run -m agy/gemini-4-hydrogen#medium "Inspect src/ and list public APIs"
  ```
- **Inside Full OpenCode TUI (`opencode`):**
  - Select any `agy/*` model via `/models`.
  - Run `/agy <task>` directly (switches the turn onto `agy/gemini-4-hydrogen#medium` immediately without calling another model).
  - Run `/swarm <task>` to launch an Antigravity multi-agent swarm, watch live workers/subagents in the right sidebar, and run `/agy-swarm` (or click `[Board]` / `[Inspect]`) to view the full board posts and subagent transcripts.
- **Standalone Antigravity Terminal CLI (No OpenCode):**
  ```bash
  agy
  agy -i "Refactor module"
  agy --model gemini-4-hydrogen-medium -p "Explain package.json scripts"
  ```

---

## Available Models

| OpenCode ID | Variants |
| --- | --- |
| `agy/gemini-4-hydrogen` | `low`, `medium`, `high`, `xhigh` |
| `agy/gemini-4-argon` | `low`, `medium`, `high` |
| `agy/gemini-3.8-flash` | `low`, `medium`, `high` |
| `agy/gemini-pro-orchestrator-g1-pro` | — |
| `agy/claude-opus-5-5` | `low`, `medium`, `high` |
| `agy/claude-sonnet-5-5` | `low`, `medium`, `high` |
| `agy/gpt-oss-120b-medium` | — |

---

## Documentation

- [Configuration & Policy Reference](./docs/configuration.md)
- [Architecture & Hook Lifecycle](./docs/architecture.md)
- [Troubleshooting](./docs/troubleshooting.md)
- [Bundled `@agy` Skill](./skills/agy/SKILL.md) & [`/agy` Command Template](./commands/agy.md)
- [Changelog](./CHANGELOG.md)

---

## Development & Verification

```bash
npm install
npm run typecheck
npm test
```

## License

[MIT](./LICENSE)
