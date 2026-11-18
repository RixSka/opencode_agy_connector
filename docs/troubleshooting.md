# Troubleshooting

## 1. Installing or Updating from GitHub Fails

OpenCode installs Git packages using your system Git credentials and `ssh`/`https` configuration (required when using SSH or accessing a private fork/repository).

Check:

1. Verify GitHub CLI or SSH access works non-interactively in your shell:
   ```bash
   gh auth status
   git ls-remote https://github.com/RixSka/opencode_agy_connector.git
   # or, if using SSH:
   git ls-remote ssh://git@github.com/RixSka/opencode_agy_connector.git
   ```
2. Prefer whichever transport your local credentials match:
   ```bash
   opencode plugin add github:RixSka/opencode_agy_connector
   # or HTTPS explicitly:
   opencode plugin add git+https://github.com/RixSka/opencode_agy_connector.git#main
   # or SSH explicitly:
   opencode plugin add git+ssh://git@github.com/RixSka/opencode_agy_connector.git#main
   ```
3. To update later:
   ```bash
   opencode plugin check
   opencode plugin update
   opencode service restart
   ```

---

## 2. `agy/*` Models Do Not Appear in `opencode models`

1. Check `"policies"` in `~/.config/opencode/opencode.jsonc` and project `.opencode/opencode.jsonc`. If `"provider.use"` denies `*`, ensure `{ "action": "provider.use", "resource": "agy", "effect": "allow" }` is declared after the deny rule.
2. Verify the plugin loaded without errors:
   ```bash
   opencode plugin list
   tail -n 100 ~/.local/share/opencode/log/opencode.log | grep -iE "agy|error"
   ```
3. Restart the background OpenCode daemon after config/plugin edits:
   ```bash
   opencode service restart
   ```

---

## 3. `Failed to spawn 'agy'`

The background OpenCode daemon may run with a minimal `PATH` that does not include custom binary locations.

- Verify where `agy` is installed:
  ```bash
  which agy
  agy --version
  ```
- By default, the connector automatically appends `~/.local/bin` to `PATH`. If `agy` is installed elsewhere, set `"binaryPath"` in plugin options or export `AGY_BIN` in the OpenCode service environment.

---

## 4. `agy` Fails Headless Permission Checks

Headless `agy -p` cannot answer interactive approval prompts.

- Under `build` and coding agents, the native `agy/*` provider passes `--mode accept-edits` by default (configurable via `"mode"` in plugin options) so file creations and edits succeed without interactive prompts.
- Under read-only agents (`plan`, `reviewer`, `explore`), writes remain blocked intentionally.
- For shell commands inside `agy` (including swarm workers or when delegating with the `agy` tool), commands outside `~/.gemini/antigravity-cli/settings.json` `permissions.allow` are auto-denied unless `"allowAllTools": true` is configured in plugin options (for native `agy/*` coding agents), `allow_all_tools: true` is passed explicitly in the delegation tool call, or matching rules are added to `~/.gemini/antigravity-cli/settings.json`.
- For long-running `/swarm` sessions, `swarmTimeoutSeconds` defaults to `0` (no print timeout) so multi-worker swarms are not cut off after `timeoutSeconds` (`600`s).

---

## 5. Authentication, Model Catalog, or Quota Errors

Test the underlying CLI directly outside OpenCode to distinguish CLI/account issues from plugin issues:

```bash
agy models
agy --output-format json --model gemini-4-hydrogen-medium -p "Reply with OK"
```

If `agy` is unauthenticated, run `agy` interactively in a terminal to complete login.

---

## 6. Top-Level `opencode --model` Returns an Unknown Flag Error

In OpenCode v2, top-level `opencode` does not accept `--model`:

- Use `opencode mini -m agy/gemini-4-hydrogen#medium` for a quick TUI session directly on Antigravity.
- Use `opencode run -m agy/gemini-4-hydrogen#medium "<prompt>"` for non-interactive runs.
- Inside full `opencode`, switch with `/models`, run `/agy <task>`, or set `"model": "agy/gemini-4-hydrogen#medium"` in `opencode.jsonc`.
