# Changelog

## 1.1.0 - 2026-11-16

### Added
- Built-in `/context` command (`ctx.command.transform` + direct `agy/*` provider interception) that displays Antigravity's real context window usage, visual category breakdown (`System & agy Tools`, `User Prompts`, `Tool Calls`, `Assistant & History`), step-by-step trajectory from `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`, live quota buckets (`agy -p "/usage"`), and direct `agy --conversation <id>` links without spending LLM tokens.
- Built-in `/usage` command for `agy/*` models (`ctx.command.transform` + `doStream` interception) and dynamic plan-aware model initialization (`discoverPlanCatalog` over `agy models`, `/usage`, and `/credits`), annotating `/models` entries with live quota badges and refreshing model status on demand.

### Fixed
- Accurate OpenCode token and context accounting: populate `inputTokens.noCache` (`tokens.input`), compute `inputTokens.total = noCache + cacheRead`, use the latest `step_update` `DONE` call for active context window size (instead of `result.usage` multi-step/multi-turn cumulative sums), set real model `limit.context` (`1,000,000` for Gemini 4 / Claude 5.5, `128,000` for GPT-OSS 120B), and strip redundant `<conversation-checkpoint>` blocks when resuming an active `agy --conversation`.

## 1.0.1 - 2026-11-16

### Changed
- Set `medium` (`gemini-4-hydrogen-medium` / `agy/gemini-4-hydrogen#medium`) as the default effort variant for `gemini-4-hydrogen`, the `/agy` command, the `agy` delegation tool, and the bundled `@agy` skill (`#high` and `#xhigh` remain selectable variants).

## 1.0.0 - 2026-11-16

### Added
- Native `agy/*` AI SDK v3 model provider supporting 7 Antigravity model families (`gemini-4-hydrogen`, `gemini-4-argon`, `gemini-3.8-flash`, `gemini-pro-orchestrator-g1-pro`, `claude-opus-5-5`, `claude-sonnet-5-5`, `gpt-oss-120b-medium`) and `#low` / `#medium` / `#high` / `#xhigh` effort variants.
- Built-in `/agy` slash command (`ctx.command.transform`) for immediate zero-intermediary switching to Antigravity even when other configured providers are unavailable or rate-limited.
- Bundled `@agy` skill (`skills/agy/SKILL.md` registered via `ctx.skill.transform`) plus standalone `commands/agy.md` template.
- Explicit `agy` delegation tool (`ctx.tool.transform`) for cross-model delegation with structured error diagnostics, 100 KB output capping, and `conversation_id` resume support.
- Persistent OpenCode session continuity (`--conversation` backed by `ctx.storage`), live NDJSON `providerExecuted` tool streaming, instant session title hook, attachment staging, scrubbed subprocess environment, and strict read-only guardrails for `plan`/`reviewer`/`explore`.
- Plugin options support (`binaryPath`, `defaultModel`, `defaultVariant`, `defaultToolModel`, `timeoutSeconds`, `allowAllTools`, `readOnlyAgents`, and per-feature registration toggles).
- Strict TypeScript typechecking (`tsc --noEmit`), unit test suite (`node --test`), and Markdown documentation (`README.md`, `docs/*`).
