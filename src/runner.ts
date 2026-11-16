import { spawn, type ChildProcess } from "node:child_process"
import { MAX_CAPTURE_BYTES } from "./types.ts"

export interface SpawnedAgyProcess {
  readonly child: ChildProcess
  readonly cleanup: () => void
  readonly terminateChild: () => void
}

export interface BufferedAgyResult {
  readonly code: number | null
  readonly signalName: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** Spawn `agy` with `AbortSignal` propagation and timeout escalation (`SIGTERM` -> `SIGKILL`). */
export function spawnAgyProcess(
  bin: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number,
  signal: AbortSignal | undefined,
  onTimeout: () => void,
): SpawnedAgyProcess {
  const child = spawn(bin, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })

  let killEscalation: ReturnType<typeof setTimeout> | undefined
  let hardTimer: ReturnType<typeof setTimeout> | undefined

  const terminateChild = () => {
    if (!child.killed) {
      child.kill("SIGTERM")
      killEscalation = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL")
      }, 3000)
    }
  }

  const onAbort = () => terminateChild()
  if (signal) {
    if (signal.aborted) {
      terminateChild()
    } else {
      signal.addEventListener("abort", onAbort, { once: true })
    }
  }

  if (timeoutSeconds > 0) {
    hardTimer = setTimeout(() => {
      onTimeout()
      terminateChild()
    }, (timeoutSeconds + 15) * 1000)
  }

  const cleanup = () => {
    if (hardTimer) clearTimeout(hardTimer)
    if (killEscalation) clearTimeout(killEscalation)
    signal?.removeEventListener("abort", onAbort)
  }

  return { child, cleanup, terminateChild }
}

/** Collect bounded stdout/stderr for buffered `agy` delegation tool runs. */
export async function runAgyBuffered(
  bin: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<BufferedAgyResult> {
  return await new Promise((resolve, reject) => {
    let timedOut = false
    const { child, cleanup } = spawnAgyProcess(bin, args, cwd, env, timeoutSeconds, signal, () => {
      timedOut = true
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0

    const collect = (chunks: Buffer[], currentBytes: number, chunk: Buffer): number => {
      if (currentBytes >= MAX_CAPTURE_BYTES) return currentBytes
      const remaining = MAX_CAPTURE_BYTES - currentBytes
      const slice = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk
      chunks.push(slice)
      return currentBytes + slice.byteLength
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBytes = collect(stdoutChunks, stdoutBytes, chunk)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = collect(stderrChunks, stderrBytes, chunk)
    })
    child.on("error", (err) => {
      cleanup()
      reject(err)
    })
    child.on("close", (code, signalName) => {
      cleanup()
      resolve({
        code,
        signalName,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
      })
    })
  })
}
