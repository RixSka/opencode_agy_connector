---
name: agy
description: Delegate scoped heavy coding, refactoring, test generation, or deep analysis tasks to the headless Antigravity CLI using Gemini 4 Hydrogen medium, or route directly to native agy/* models.
---

# Antigravity CLI (`agy`) Delegation Skill

Delegate heavy, self-contained coding, refactoring, test generation, PDF/multimodal file parsing, or deep analysis tasks to Antigravity (`agy`) running `gemini-4-hydrogen-medium` by default.

## Two Ways Antigravity Runs

1. **Direct Native Model (`agy/*` or `/agy <task>`):** Runs directly on `agy/gemini-4-hydrogen#medium` (and sibling `agy/*` models) via OpenCode without invoking any intermediary model.
2. **Tool Delegation (`agy` tool or headless `agy -p`):** Lets another OpenCode session delegate a scoped task to `agy` while keeping OpenCode's main thread responsive.

## When to Trigger Delegation

Use `agy` delegation when offloading a scoped, high-compute task from another model is beneficial:

- **Large file parsing & deep analysis:** Reviewing or extracting structured findings across large files, logs, schemas, PDFs, or unfamiliar subsystems.
- **Test suite generation:** Writing comprehensive unit, integration, or regression test suites for well-defined modules.
- **Multi-file refactoring:** Executing a scoped, coherent refactor or mechanical migration across multiple related files.
- **Independent review / root-cause analysis:** Getting a deep second-model architectural audit or bug diagnosis.

**Do NOT trigger** delegation for trivial edits, single quick reads, simple shell checks, or ambiguous tasks that need interactive clarification before starting.

## Execution Rules

### 1. Prefer the Registered `agy` Tool (CLI Fallback via `agy -p`)

When `opencode_agy_connector` is active, prefer calling the registered `agy` tool directly (it enforces CWD workspace scoping, scrubbed environment variables, a 100 KB output cap, structured `AGY_ERROR` reporting, and returns `conversation_id`).

If the `agy` tool is disabled or unavailable, invoke `agy` directly in non-interactive print mode (`-p` / `--print`) from the active project's current working directory (`pwd`). Never launch interactive TUI mode (`agy` without `-p`) inside a non-interactive shell tool.

- **Default model:** `gemini-4-hydrogen-medium` (verified `agy models` ID; equivalent CLI flags: `--model gemini-4-hydrogen-medium` or `--model gemini-4-hydrogen --effort medium`). Do not switch models or lower reasoning effort unless the user explicitly asks.
- **Workspace scope:** Run inside the current working directory (`pwd`). Only pass `add_dirs` / `--add-dir <path>` when the task explicitly spans an outside directory.

```bash
PROMPT=$(cat <<'EOF'
<self-contained prompt>
EOF
)

agy -p "$PROMPT" --model gemini-4-hydrogen-medium --output-format json --print-timeout 600s
```

### 2. Choose Headless Permission & Output Flags Deliberately

Headless mode cannot answer interactive confirmation prompts; any unpermitted tool call is auto-denied.

- **Read-only research / analysis:**
  Leave `mode` omitted or use `mode: "plan"` (`--mode plan`) and state read-only constraints explicitly in the prompt. Note that shell commands outside `permissions.allow` in `~/.gemini/antigravity-cli/settings.json` will still be auto-denied unless explicitly allowed.
- **File creation, refactoring, or test writing:**
  Use `mode: "accept-edits"` (`--mode accept-edits`) so `agy` can create and edit workspace files non-interactively.
- **Full tool execution (only when explicitly appropriate):**
  Only pass `allow_all_tools: true` (`--dangerously-skip-permissions`) when the delegated task requires running shell commands outside `permissions.allow`, and only when safe for the workspace. Never instruct `agy` to run destructive or remote-mutating commands (`git push`, `rm -rf`, etc.) unless the user explicitly asked for them.
- **Timeouts & slash expansion:**
  - Leave `timeout_seconds` at the `600` default (or `--print-timeout 600s`, or `0s` for unbounded) — avoid short timeouts like `30s`, because high-effort reasoning spends time before outputting text.
  - Pass `disable_slash_commands: true` (`--disable-slash-commands`) if the prompt contains literal `/...` tokens that should not be expanded.

### 3. Pass Completely Self-Contained Prompts

Fresh `agy` delegation runs start with **zero access to OpenCode's prior chat history**. Every delegated prompt MUST include everything `agy` needs on its own:

1. **Objective & Boundaries:** Exact goal, expected deliverables, and explicit out-of-scope rules (what not to modify).
2. **Context & Constraints:** Architecture notes, conventions, language/framework versions, error messages, or decisions already established in this conversation.
3. **Exact Paths & Symbols:** Explicit relative file/directory paths from the current working directory and relevant symbol names.
4. **Verification & Output Expectations:** Specify whether `agy` should only edit files or also run checks, and require a concise final summary listing modified files, key changes, commands run, and any caveats.

Prompt template:

```text
Repository context: <concise summary of tech stack, conventions, and relevant decisions>
Task: <specific coding, refactoring, test generation, or analysis objective>
Scope:
- Target files/directories: <exact relative paths>
- Constraints / Do not touch: <constraints, API compatibility rules, excluded files>
Verification: <checks to run if allowed, or state "Do not run commands; OpenCode will verify">
Output: Summarize modified files, changes made, and any edge cases or unresolved issues.
```

### 4. Resuming Long or Timed-Out Runs (`conversation_id`)

Both `--output-format json` and the `agy` tool return a `conversation_id` (even when `agy` stops due to `print_timeout`).

- **When to resume:** Only when continuing a partial multi-step refactor or recovering from a timeout (`DEADLINE_EXCEEDED` / `print_timeout`) where a `conversation_id` was returned.
- **How to resume:** Pass `conversation_id` to the `agy` tool, or run:
  ```bash
  agy --conversation "<conversation_id>" -p "<next-step or finish-up instructions>" --model gemini-4-hydrogen-medium --output-format json
  ```
- Inspect `git status` / `git diff` first so the follow-up prompt accounts for edits already written before the timeout.

## Error Handling

Check **both** the exit code and stdout/stderr output on every run. **Never retry blindly** with the same arguments.

- **Non-zero exit code or `AGY_ERROR:` payload:**
  Stop immediately and surface the exit code, full error message, `AGY_ERROR` details (if present), `conversation_id` (if returned), and any partial output to the user.
- **Headless permission auto-denial (CLI can exit `0`!):**
  If `agy` prints `no output produced — a tool required the "..." permission that headless mode cannot prompt for`, treat it as a failed/incomplete run. Report the exact blocked permission to the user and either:
  - re-run with `mode: "accept-edits"` (`--mode accept-edits`) if only file edits were needed,
  - run the blocked verification command directly inside OpenCode instead, or
  - ask the user before passing `allow_all_tools: true` (`--dangerously-skip-permissions`) or updating `~/.gemini/antigravity-cli/settings.json`.
- **Timeout (`DEADLINE_EXCEEDED` / `print_timeout`):**
  Report the timeout, partial output, and `conversation_id`. Inspect `git status` / `git diff` if edits were permitted. Either resume cleanly via `conversation_id` with narrower scope/longer timeout or ask the user how to proceed.
- **Missing binary or auth/model error:**
  If `agy` is missing from `PATH`, fails authentication, or rejects a model ID, surface the exact error and stop. Tell the user to verify `which agy`, authenticate via `agy`, or check `agy models` rather than silently substituting a different model.

## Post-Delegation Check

After `agy` completes any task that modifies files:
1. Inspect `git status` and `git diff` (or read the touched files) to verify scope and code quality.
2. Run the project's tests, typecheck, or linter in OpenCode if `agy` did not run them.
3. Report only verified files, changes, and test results to the user.
