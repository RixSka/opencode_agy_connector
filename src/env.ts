import path from "node:path"
import { DEFAULT_TIMEOUT_SECONDS } from "./types.ts"

const ALLOWED_ENV_KEYS = [
  "AGY_BIN",
  "Apple_PubSub_Socket_Render",
  "DBUS_SESSION_BUS_ADDRESS",
  "GEMINI_API_KEY",
  "HOME",
  "LANG",
  "LOGNAME",
  "PATH",
  "SECURITYSESSIONID",
  "SHELL",
  "SSH_AUTH_SOCK",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "__CF_USER_TEXT_ENCODING",
] as const

/** Build a minimal, scrubbed environment map for spawned `agy` subprocesses. */
export function buildSanitizedEnv(
  sourceEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    CI: "1",
    NO_COLOR: "1",
    TERM: "dumb",
  }

  for (const key of ALLOWED_ENV_KEYS) {
    const value = sourceEnv[key]
    if (value !== undefined) env[key] = value
  }

  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value !== undefined && (key.startsWith("LC_") || key.startsWith("XDG_"))) {
      env[key] = value
    }
  }

  if (env.HOME) {
    const localBin = path.join(env.HOME, ".local", "bin")
    const currentPath = env.PATH ?? "/usr/local/bin:/usr/bin:/bin"
    if (!currentPath.split(path.delimiter).includes(localBin)) {
      env.PATH = `${localBin}${path.delimiter}${currentPath}`
    }
  }

  return env
}

/** Resolve the `agy` executable path from plugin options, `AGY_BIN`, or `PATH`. */
export function resolveAgyBinary(binaryPath?: string, env: Record<string, string> = {}): string {
  return binaryPath?.trim() || env.AGY_BIN?.trim() || "agy"
}

/** Resolve and validate extra `--add-dir` paths relative to the active workspace directory. */
export function resolveAddDirs(workspaceDir: string, addDirs?: readonly string[]): string[] {
  if (!addDirs || addDirs.length === 0) return []
  return addDirs.map((dir) => {
    const trimmed = dir.trim()
    if (!trimmed || trimmed.includes("\0")) {
      throw new Error(`Invalid add_dirs entry: ${JSON.stringify(dir)}`)
    }
    return path.isAbsolute(trimmed) ? trimmed : path.resolve(workspaceDir, trimmed)
  })
}

/** Normalize an optional timeout value into a non-negative integer number of seconds. */
export function resolveTimeoutSeconds(
  timeoutSeconds?: number,
  fallbackSeconds: number = DEFAULT_TIMEOUT_SECONDS,
): number {
  if (timeoutSeconds === undefined) return fallbackSeconds
  if (!Number.isFinite(timeoutSeconds)) return fallbackSeconds
  return Math.max(0, Math.floor(timeoutSeconds))
}
