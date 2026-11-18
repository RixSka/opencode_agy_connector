import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { hasActiveAgySwarm, readAgyAgentsSnapshot } from "../src/subagents.ts"

test("readAgyAgentsSnapshot parses Antigravity swarm roster, board posts, member activity, and deduplicates subagents", () => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), "agy-swarm-test-"))
  try {
    const cliBrain = path.join(tempHome, ".gemini", "antigravity-cli", "brain")
    const coordId = "coord-1111-2222-3333"
    const worker1Id = "work1-1111-2222-3333"
    const worker2Id = "work2-1111-2222-3333"
    const worker3Id = "work3-1111-2222-3333"
    const standaloneSubId = "sub1-1111-2222-3333"

    const swarmDir = path.join(cliBrain, coordId, ".system_generated", "swarm")
    const subagentsDir = path.join(cliBrain, coordId, ".system_generated", "subagents")
    mkdirSync(swarmDir, { recursive: true })
    mkdirSync(subagentsDir, { recursive: true })

    writeFileSync(
      path.join(swarmDir, "swarm.json"),
      JSON.stringify({ version: 1, backend: "local", swarm_id: coordId }),
    )
    writeFileSync(
      path.join(swarmDir, "plan.json"),
      JSON.stringify({
        goal: {
          title: "Refactor auth & tests",
          line: "Split modules and verify suite",
        },
      }),
    )
    writeFileSync(
      path.join(swarmDir, "members.json"),
      JSON.stringify({
        title: "Auth Refactor Swarm",
        members: {
          coordinator: {
            conversation_id: coordId,
            role: "coordinator",
            model: "gemini-4-hydrogen-xhigh",
            workspace_mode: "inherit",
            wake_mode: "mentions",
            last_read_seq: 3,
            killed: false,
          },
          parser: {
            conversation_id: worker1Id,
            role: "worker",
            model: "gemini-4-hydrogen-medium",
            workspace_mode: "share",
            workspace: "/tmp/wt/parser",
            wake_mode: "working",
            last_read_seq: 1,
            killed: false,
          },
          verifier: {
            conversation_id: worker2Id,
            role: "worker",
            model: "gemini-3.8-flash-low",
            workspace_mode: "inherit",
            wake_mode: "mentions",
            last_read_seq: 3,
            killed: false,
          },
          retired: {
            conversation_id: worker3Id,
            role: "worker",
            model: "gemini-3.8-flash-low",
            workspace_mode: "share",
            wake_mode: "working",
            last_read_seq: 2,
            killed: true,
          },
        },
      }),
    )

    writeFileSync(
      path.join(swarmDir, "board.jsonl"),
      [
        JSON.stringify({ seq: 1, agent: "coordinator", text: "@parser fix src/auth.ts", time: "2026-11-18 20:00:00", kind: "brief" }),
        JSON.stringify({ seq: 2, agent: "parser", text: "@verifier ready for check", time: "2026-11-18 20:01:00" }),
        JSON.stringify({ seq: 3, agent: "verifier", text: "@coordinator all checks green", time: "2026-11-18 20:02:00" }),
      ].join("\n"),
    )

    // Coordinator transcript: parked on swarm_wait (waiting)
    const writeTranscript = (convId: string, steps: Record<string, unknown>[]) => {
      const logDir = path.join(cliBrain, convId, ".system_generated", "logs")
      mkdirSync(logDir, { recursive: true })
      writeFileSync(
        path.join(logDir, "transcript.jsonl"),
        steps.map((s) => JSON.stringify(s)).join("\n"),
      )
    }

    writeTranscript(coordId, [
      { step_index: 0, type: "USER_INPUT", status: "DONE", content: "/swarm Refactor auth" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-hydrogen-xhigh",
        input_tokens: 12000,
        cache_read_tokens: 8000,
        output_tokens: 150,
        tool_calls: [{ name: "swarm_wait", args: { since: 1 } }],
      },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "woke" },
    ])

    // Worker 1 (parser): currently working on edit_file
    writeTranscript(worker1Id, [
      { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "Brief" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-4-hydrogen-medium",
        input_tokens: 20000,
        cache_read_tokens: 5000,
        output_tokens: 320,
        thinking: "**Updating token parser**\nChecking edge cases",
        tool_calls: [{ name: "edit_file", args: { Path: '"/repo/src/auth.ts"' } }],
      },
    ])

    // Worker 2 (verifier): blocked on ask_question
    writeTranscript(worker2Id, [
      { step_index: 0, type: "SYSTEM_MESSAGE", status: "DONE", content: "Verify" },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        model: "gemini-3.8-flash-low",
        input_tokens: 5000,
        cache_read_tokens: 1000,
        output_tokens: 40,
        tool_calls: [{ name: "ask_question", args: {} }],
      },
    ])

    // Worker 3 (retired): killed
    writeTranscript(worker3Id, [
      { step_index: 0, type: "ERROR_MESSAGE", status: "ERROR", error: "RESOURCE_EXHAUSTED quota 429" },
    ])

    // Subagents dir includes BOTH a swarm worker (should be deduplicated) and a standalone research subagent
    writeFileSync(
      path.join(subagentsDir, `${worker1Id}.json`),
      JSON.stringify({
        conversationId: worker1Id,
        subagentDescriptor: { typeName: "worker", role: "Swarm Worker (parser)" },
        state: "SUBAGENT_STATE_ALIVE",
        spawnStepIndex: 1,
        workspaceUris: ["file:///tmp/wt/parser"],
      }),
    )
    writeFileSync(
      path.join(subagentsDir, `${standaloneSubId}.json`),
      JSON.stringify({
        conversationId: standaloneSubId,
        subagentDescriptor: { typeName: "research", role: "Schema Auditor" },
        state: "SUBAGENT_STATE_ALIVE",
        spawnStepIndex: 3,
        workspaceUris: ["file:///repo"],
      }),
    )

    writeTranscript(standaloneSubId, [
      {
        step_index: 0,
        type: "SYSTEM_MESSAGE",
        status: "DONE",
        created_at: "2026-11-18T19:00:00Z",
        content: "<SYSTEM_MESSAGE>\n[Message] content=Inspect schema.ts\n</SYSTEM_MESSAGE>",
      },
      {
        step_index: 1,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-18T19:00:02Z",
        model: "gemini-3.8-flash-low",
        input_tokens: 4000,
        cache_read_tokens: 2000,
        output_tokens: 80,
        tool_calls: [{ name: "read_file", args: { Path: '"/repo/schema.ts"' } }],
      },
      { step_index: 2, type: "GENERIC", status: "DONE", content: "file content" },
      {
        step_index: 3,
        type: "PLANNER_RESPONSE",
        status: "DONE",
        created_at: "2026-11-18T19:00:05Z",
        model: "gemini-3.8-flash-low",
        input_tokens: 6500,
        cache_read_tokens: 3000,
        output_tokens: 65,
        content: "Schema looks clean.",
      },
    ])

    assert.equal(hasActiveAgySwarm(coordId, tempHome), true)
    assert.equal(hasActiveAgySwarm("non-existent-id", tempHome), false)

    const snap = readAgyAgentsSnapshot({
      sessionID: "ses_abc",
      conversationId: coordId,
      homeDir: tempHome,
      nowMs: Date.parse("2026-11-18T19:05:00Z"),
    })

    assert.ok(snap.swarm)
    assert.equal(snap.swarm.title, "Auth Refactor Swarm")
    assert.equal(snap.swarm.goalTitle, "Refactor auth & tests")
    assert.equal(snap.swarm.head, 3)
    assert.equal(snap.swarm.postCount, 3)
    assert.equal(snap.swarm.members.length, 4)

    const byName = new Map(snap.swarm.members.map((m) => [m.name, m]))
    assert.equal(byName.get("coordinator")?.status, "waiting")
    assert.equal(byName.get("coordinator")?.contextTokens, 20000)

    assert.equal(byName.get("parser")?.status, "working")
    assert.equal(byName.get("parser")?.activity, "Edit auth.ts")
    assert.equal(byName.get("parser")?.activityKind, "tool")
    assert.equal(byName.get("parser")?.posts, 1)
    assert.equal(byName.get("parser")?.unread, 2)
    assert.equal(byName.get("parser")?.workspaceMode, "share")
    assert.equal(byName.get("parser")?.contextTokens, 25000)

    assert.equal(byName.get("verifier")?.status, "blocked")
    assert.equal(byName.get("verifier")?.blockedTool, "AskQuestion")

    assert.equal(byName.get("retired")?.status, "killed")

    // Standalone subagents list deduplicates swarm workers!
    assert.equal(snap.subagents.length, 1)
    assert.equal(snap.subagents[0]?.conversationId, standaloneSubId)
    assert.equal(snap.subagents[0]?.role, "Schema Auditor")
    assert.equal(snap.subagents[0]?.typeName, "research")
    assert.equal(snap.subagents[0]?.model, "gemini-3.8-flash-low")
    assert.equal(snap.subagents[0]?.status, "done")
    assert.equal(snap.subagents[0]?.steps, 4)
    assert.equal(snap.subagents[0]?.contextTokens, 9500)
    assert.equal(snap.subagents[0]?.outputTokens, 145)
    assert.equal(snap.subagents[0]?.initialPrompt, "Inspect schema.ts")
    assert.equal(snap.subagents[0]?.lastMessage, "Schema looks clean.")
  } finally {
    rmSync(tempHome, { recursive: true, force: true })
  }
})
