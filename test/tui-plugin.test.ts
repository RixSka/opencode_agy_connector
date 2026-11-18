import assert from "node:assert/strict"
import test from "node:test"
import tuiPlugin from "../src/tui.ts"

test("tui plugin setup wires sidebar.content slot, startup retry, /agy-refresh command, and RPC events", async () => {
  const calls: Array<{ forceRefresh: boolean }> = []
  const agentCalls: Array<{ sessionID: string }> = []
  let updatedHandler: ((event: { data: { json: string } }) => void) | undefined
  let agentsUpdatedHandler: ((event: { data: { sessionID?: string; json: string } }) => void) | undefined
  let sidebarClaim: { append?: string; render?: (input: { sessionID: string }) => unknown } | undefined
  let appClaim: { append?: string; render?: () => unknown } | undefined
  const registeredCommands: Array<{ id?: string; run?: () => void }> = []
  const toasts: Array<{ title?: string; message?: string; variant?: string }> = []
  let dialogShown = false

  const makeSnapshot = (pct: number) =>
    JSON.stringify({
      planTier: "Pro Plan (Separate Argon + Gemini + Claude/GPT Pools)",
      remainingCredits: 950,
      quotaGroups: [
        {
          modelGroup: "Gemini Models",
          window: "weekly",
          remainingPct: pct,
          resetUtc: "2026-11-21T15:23:01Z",
        },
        {
          modelGroup: "Gemini 4 Argon",
          window: "weekly",
          remainingPct: 0,
          resetUtc: "2026-11-22T17:12:51Z",
        },
      ],
      updatedAt: "2026-11-16T04:15:00Z",
    })

  let failFirst = true
  const mockContext = {
    location: { directory: "/tmp/workspace" },
    theme: {
      text: {
        base: "#ffffff",
        muted: "#888888",
        feedback: {
          success: { base: "#00ff00" },
          warning: { base: "#ffff00" },
          error: { base: "#ff0000" },
        },
        action: { primary: { selected: "#00aaff" } },
      },
    },
    client: {
      rpc: () => ({
        getUsage: async (input: { forceRefresh: boolean }) => {
          calls.push(input)
          if (failFirst) {
            failFirst = false
            throw new Error("RPC is unavailable: opencode.agy.usage")
          }
          return { json: makeSnapshot(input.forceRefresh ? 58 : 62) }
        },
        getAgents: async (input: { sessionID: string }) => {
          agentCalls.push(input)
          return {
            json: JSON.stringify({
              sessionID: input.sessionID,
              swarm: null,
              subagents: [],
              updatedAt: "2026-11-18T20:05:00Z",
            }),
          }
        },
        events: {
          on: (name: string, fn: (event: { data: { sessionID?: string; json: string } }) => void) => {
            if (name === "updated") updatedHandler = fn
            if (name === "agentsUpdated") agentsUpdatedHandler = fn
            return () => {
              if (name === "updated") updatedHandler = undefined
              if (name === "agentsUpdated") agentsUpdatedHandler = undefined
            }
          },
        },
      }),
    },
    keymap: {
      layer: (factory: () => { commands?: Array<{ id?: string; run?: () => void }> }) => {
        const res = factory()
        if (res.commands) registeredCommands.push(...res.commands)
      },
    },
    ui: {
      router: {
        current: () => ({ type: "session", sessionID: "ses_live_1" }),
      },
      dialog: {
        set: () => {},
        show: () => {
          dialogShown = true
        },
        clear: () => {},
      },
      toast: {
        show: (toast: { title?: string; message?: string; variant?: string }) => toasts.push(toast),
      },
      slot: (claim: { append?: string; render?: (input: { sessionID: string }) => unknown }) => {
        if (claim.append === "sidebar.content") sidebarClaim = claim
        if (claim.append === "app") appClaim = claim as { append?: string; render?: () => unknown }
        return () => {}
      },
    },
  }

  const cleanup = await tuiPlugin.setup(mockContext as never)
  try {
    assert.ok(sidebarClaim?.render)
    appClaim?.render?.()
    assert.equal(registeredCommands[0]?.id, "agy.usage.refresh")
    assert.equal(registeredCommands[1]?.id, "agy.swarm.board")

    // Initial RPC call attempted immediately on boot
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.forceRefresh, false)

    // Startup retry fires automatically after initial failure (1.5s)
    await new Promise((r) => setTimeout(r, 1700))
    assert.equal(calls.length, 2)
    assert.equal(calls[1]?.forceRefresh, false)
    assert.ok(agentCalls.length >= 1)
    assert.equal(agentCalls[0]?.sessionID, "ses_live_1")

    // Manual refresh command calls RPC with forceRefresh: true and shows toast
    registeredCommands[0]?.run?.()
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(calls.length, 3)
    assert.equal(calls[2]?.forceRefresh, true)
    assert.equal(toasts.length, 1)
    assert.match(toasts[0]?.message ?? "", /2 bucket/)

    // /agy-swarm command opens the Swarm & Subagents inspector modal
    registeredCommands[1]?.run?.()
    assert.equal(dialogShown, true)

    // Event listeners stay subscribed until cleanup runs
    assert.ok(updatedHandler)
    assert.ok(agentsUpdatedHandler)
  } finally {
    if (typeof cleanup === "function") await cleanup()
    assert.equal(updatedHandler, undefined)
    assert.equal(agentsUpdatedHandler, undefined)
  }
})
