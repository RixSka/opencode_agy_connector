import type { Plugin } from "@opencode/plugin"
import { buildSanitizedEnv, resolveAddDirs, resolveAgyBinary, resolveTimeoutSeconds } from "./env.ts"
import { buildFailureMessage, capBytes, parseAgyOutput } from "./output.ts"
import { runAgyBuffered } from "./runner.ts"
import type { AgyConnectorConfig, AgyToolInput } from "./types.ts"

/** Build CLI arguments for the explicit `agy` delegation tool. */
export function buildToolAgyArgs(
  input: AgyToolInput,
  workspaceDir: string,
  timeoutSec: number,
  defaultToolModel: string,
): string[] {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new Error("The `prompt` argument must be a non-empty string.")
  }

  const args: string[] = [
    "-p",
    prompt,
    "--model",
    input.model?.trim() || defaultToolModel,
    "--output-format",
    "json",
  ]

  if (input.effort) args.push("--effort", input.effort)
  if (input.mode && input.mode !== "default") args.push("--mode", input.mode)
  if (input.conversation_id?.trim()) args.push("--conversation", input.conversation_id.trim())
  args.push("--print-timeout", `${timeoutSec}s`)
  if (input.allow_all_tools) args.push("--dangerously-skip-permissions")
  if (input.disable_slash_commands) args.push("--disable-slash-commands")

  for (const dir of resolveAddDirs(workspaceDir, input.add_dirs)) {
    args.push("--add-dir", dir)
  }

  return args
}

/** Register the `agy` delegation tool inside OpenCode sessions. */
export async function registerAgyTool(
  ctx: Plugin.Context,
  config: AgyConnectorConfig,
): Promise<void> {
  const workspaceDir = ctx.location.directory

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "agy",
      description:
        "Delegate a scoped heavy coding, refactoring, test generation, PDF/file parsing, or deep analysis task to the headless Antigravity CLI (agy). Scoped to the active workspace and returns structured output with conversation_id for resuming.",
      options: { codemode: false },
      input: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "Complete, self-contained prompt (agy has no prior OpenCode chat history). Include context, exact file paths, constraints, and verification expectations.",
          },
          model: {
            type: "string",
            description: `Antigravity CLI model ID (defaults to ${config.defaultToolModel}).`,
          },
          effort: {
            type: "string",
            enum: ["low", "medium", "high", "xhigh", "max"],
            description: "Optional reasoning effort override (--effort).",
          },
          mode: {
            type: "string",
            enum: ["plan", "accept-edits", "auto", "default"],
            description:
              "Execution mode: 'plan' (read-only analysis), 'accept-edits' (non-interactive file writes), 'auto' (automatic mode), or 'default' (omits --mode).",
          },
          conversation_id: {
            type: "string",
            description: "Previous agy conversation_id to resume via --conversation.",
          },
          timeout_seconds: {
            type: "number",
            description: `Print timeout in seconds (defaults to ${config.timeoutSeconds}; pass 0 for no print timeout).`,
          },
          allow_all_tools: {
            type: "boolean",
            description:
              "Pass --dangerously-skip-permissions ONLY when shell commands outside settings.json allowlist are explicitly required.",
          },
          add_dirs: {
            type: "array",
            items: { type: "string" },
            description: "Optional extra directories to expose via --add-dir.",
          },
          disable_slash_commands: {
            type: "boolean",
            description: "Pass --disable-slash-commands so literal /tokens are not expanded.",
          },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      execute: async (rawInput, context) => {
        const input = rawInput as AgyToolInput
        const model = input.model?.trim() || config.defaultToolModel
        const timeoutSec = resolveTimeoutSeconds(input.timeout_seconds, config.timeoutSeconds)
        const args = buildToolAgyArgs(input, workspaceDir, timeoutSec, config.defaultToolModel)
        const env = buildSanitizedEnv()
        const agyBin = resolveAgyBinary(config.binaryPath, env)

        await context.progress({
          status: `Running agy (${model})${input.conversation_id ? " [resuming]" : ""}`,
        })

        let execResult
        try {
          execResult = await runAgyBuffered(agyBin, args, workspaceDir, env, timeoutSec, context.signal)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          throw new Error(
            `Failed to spawn '${agyBin}' in ${workspaceDir}: ${msg}. Verify agy is installed and on PATH.`,
          )
        }

        if (context.signal?.aborted) {
          throw new Error("agy execution was aborted by OpenCode.")
        }

        const parsed = parseAgyOutput(execResult.stdout, execResult.stderr)
        const toolSessionId = (context as { readonly sessionID?: string } | undefined)?.sessionID
        if (parsed.result?.conversation_id && toolSessionId) {
          void ctx.storage.set(`agy:tool_conv:${toolSessionId}`, parsed.result.conversation_id).catch(() => {})
        }

        const failed =
          execResult.timedOut ||
          execResult.code !== 0 ||
          Boolean(parsed.permissionBlocked) ||
          Boolean(parsed.agyError) ||
          parsed.result?.status === "ERROR"

        if (failed) {
          throw new Error(
            buildFailureMessage(execResult.code, execResult.signalName, execResult.timedOut, parsed),
          )
        }

        const meta: string[] = [
          `status: ${parsed.result?.status ?? "SUCCESS"}`,
          `model: ${model}`,
          `cwd: ${workspaceDir}`,
        ]
        if (parsed.result?.conversation_id) meta.push(`conversation_id: ${parsed.result.conversation_id}`)
        if (parsed.result?.num_turns !== undefined) meta.push(`turns: ${parsed.result.num_turns}`)
        if (parsed.result?.duration_seconds !== undefined) {
          meta.push(`duration_seconds: ${parsed.result.duration_seconds.toFixed(2)}`)
        }

        const body = parsed.result?.response?.trim() || parsed.cleanedStdout || "(no output)"
        return {
          content: capBytes(`[${meta.join(" | ")}]\n\n${body}`),
        }
      },
    })
  })
}
