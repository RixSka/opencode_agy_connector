# Architecture

`opencode_agy_connector` exposes Antigravity (`agy` CLI) through five coordinated layers inside a single OpenCode v2 plugin (`id: "agy"`):

1. **Native AI SDK v3 Model Provider (`src/provider.ts`)**
   - Registers provider `agy` (`package: "aisdk:agy-local"`) via `ctx.provider.transform`.
   - Hooks `ctx.aisdk.hook("sdk")` and `ctx.aisdk.hook("language")` with AI SDK v3 `doStream` and `doGenerate`.
   - Spawns `agy -p ... --output-format stream-json` (passing `--disable-slash-commands` unless `enableSlashCommands` is `true` or the turn uses `/swarm` / an active swarm) and parses NDJSON events live into `text-start`/`text-delta`/`text-end`, `tool-input-*`, `tool-call`, `tool-result` (`providerExecuted: true`, covering both `tool` and `subagent` steps), usage counters, and structured errors.

2. **Session Lifecycle & Context Hooks (`src/provider.ts`, `src/prompt.ts`)**
   - **`ctx.session.hook("title")`:** Computes an immediate title from the user message without spawning an auxiliary LLM process.
   - **`ctx.session.hook("context" | "compaction" | "generate")`:** Extracts custom agent system prompts, `AGENTS.md`, and session instructions (stripping OpenCode-internal harness/environment boilerplate) and forwards them via `event.options.agyMeta`.
   - **Multi-turn continuity:** Tracks `agy` `conversation_id` per OpenCode session (`ctx.storage` keys `agy:conv:<sessionID>` and `agy:agent:<sessionID>`). Subsequent turns pass `--conversation <id>` with only the new delta turn; mid-session switches from another provider replay bounded `<prior_conversation>` turns cleanly.
   - **Attachments:** Converts `file://` URLs and inline binary/base64 image or PDF parts into staged files inside `os.tmpdir()/opencode-agy-attachments` so `agy` file tools can inspect them.
   - **Read-only guardrails:** Agents listed in `readOnlyAgents` (default: `plan`, `reviewer`, `explore`), plus non-primary compaction/generate turns, omit `--mode` (`config.mode`, default `accept-edits`) and inject strict read-only instructions.

3. **Explicit Delegation Tool (`src/tool.ts`)**
   - Registers the `agy` tool (`ctx.tool.transform`) so non-Antigravity sessions (such as Claude agents) can delegate heavy analyses, refactors, PDF inspection, or test generation to headless `agy -p --output-format json`.
   - Caps returned text at 100 KB (`MAX_OUTPUT_BYTES`) and preserves `conversation_id` across both successes and failures.

4. **Bundled Skill & Commands (`src/assets.ts`, `src/context.ts`, `src/skill-doc.ts`)**
   - Reads `skills/agy/SKILL.md` from the package and registers it via `ctx.skill.transform` when no higher-precedence global or project `agy` skill exists.
   - Registers `/agy` and `/swarm` via `ctx.command.transform`, switching the active session model to `agy/<defaultModel>#<defaultVariant>` when needed (preserving the active `agy/*` model on `/swarm`) before submitting the prompt.
   - Registers `/context` and `/usage` (and intercepts them directly inside `doStream` when on `agy/*` models) to parse `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl` + `agy -p "/usage"` + `agy -p "/credits"` + `agy models`, rendering the real context breakdown, plan status, and initialized model catalog without invoking an LLM turn.

5. **Right-Sidebar TUI Widget, Swarm/Subagents Telemetry & RPC (`src/tui.ts`, `src/tui-format.ts`, `src/subagents.ts`, `src/rpc.ts`)**
   - Server registers `AgyUsageRpc` (`getUsage` + `getAgents` methods, `updated` + `agentsUpdated` events) so any TUI client receives live quota updates and real-time swarm/subagent snapshots (streaming subagent steps + `~/.gemini/antigravity-cli/brain/<id>/.system_generated/{swarm,subagents}` + per-member `transcript.jsonl` telemetry).
   - `./tui` mounts **Antigravity Quota** plus conditional **Swarm & Subagents** sections in OpenCode's `sidebar.content` slot showing each member/subagent's status (`Active`, `Waiting`, `Done`, `Blocked · <tool>`, `Quota`, `Error`, `Stuck`, `Killed`), model, current tool/thinking activity, step/token/post/unread counts, workspace mode, latest board post, `/agy-refresh` + `/agy-swarm` commands, and an interactive `[Board]` / `[Inspect]` modal.

## Subprocess Isolation & Cleanup (`src/env.ts`, `src/runner.ts`, `src/output.ts`)

- Builds a minimal scrubbed environment (`CI=1`, `NO_COLOR=1`, `TERM=dumb`, allowlisted keys, `LC_*`, `XDG_*`, and `$HOME/.local/bin` fallback in `PATH`) so unrelated provider keys from the parent process are not leaked to subprocesses.
- Propagates OpenCode `AbortSignal` cancellations and enforces hard timeout escalation (`SIGTERM` followed by `SIGKILL` after 3 seconds).
- Detects both `AGY_ERROR:` control lines and headless permission auto-denials (`no output produced ... permission that headless mode cannot prompt for`).
