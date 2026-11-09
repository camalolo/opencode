import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionCrashRecovery } from "@opencode-ai/core/session/crash-recovery"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { MessageID, PartID, SessionV1 } from "@opencode-ai/core/v1/session"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Session as SessionNs } from "@/session/session"
import { Project } from "@/project/project"
import { SessionID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([Database.node, SessionNs.node, SessionProjector.node, Project.node, CrossSpawnSpawner.node])),
)

const toolPart = (id: string, state: Record<string, unknown>) =>
  ({
    type: "tool",
    callID: "call_" + id,
    tool: "bash",
    state,
  }) as NonNullable<(typeof PartTable.$inferInsert)["data"]>

const seed = Effect.gen(function* () {
  const session = yield* SessionNs.use.create({ title: "crash-recovery" })
  const { db } = yield* Database.Service
  const sessionID = SessionID.make(session.id)
  // A second session untouched for over a day: the sweep must skip it.
  const stale = yield* SessionNs.use.create({ title: "crash-recovery-stale" })
  const staleID = SessionID.make(stale.id)
  yield* db
    .update(SessionTable)
    .set({ time_created: Date.now() - 25 * 60 * 60 * 1000, time_updated: Date.now() - 25 * 60 * 60 * 1000 })
    .where(eq(SessionTable.id, staleID))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(MessageTable)
    .values([
      {
        id: MessageID.make("msg_crash_incomplete"),
        session_id: sessionID,
        time_created: 1000,
        time_updated: 1000,
        data: {
          role: "assistant",
          agent: "build",
          modelID: "model",
          providerID: "provider",
          mode: "primary",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1000 },
          parentID: "msg_crash_parent",
        } as NonNullable<(typeof MessageTable.$inferInsert)["data"]>,
      },
      {
        id: MessageID.make("msg_crash_done"),
        session_id: sessionID,
        time_created: 1001,
        time_updated: 1001,
        data: {
          role: "assistant",
          agent: "build",
          modelID: "model",
          providerID: "provider",
          mode: "primary",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1001, completed: 1002 },
          parentID: "msg_crash_parent",
        } as NonNullable<(typeof MessageTable.$inferInsert)["data"]>,
      },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(PartTable)
    .values([
      {
        id: PartID.make("prt_crash_running"),
        message_id: MessageID.make("msg_crash_incomplete"),
        session_id: sessionID,
        time_created: 1000,
        time_updated: 2000,
        data: toolPart("running", { status: "running", input: { command: "sleep 999" }, time: { start: 1500 } }),
      },
      {
        id: PartID.make("prt_crash_pending"),
        message_id: MessageID.make("msg_crash_incomplete"),
        session_id: sessionID,
        time_created: 1000,
        time_updated: 2000,
        data: toolPart("pending", { status: "pending", input: {}, raw: "" }),
      },
      {
        id: PartID.make("prt_crash_done"),
        message_id: MessageID.make("msg_crash_done"),
        session_id: sessionID,
        time_created: 1001,
        time_updated: 2001,
        data: toolPart("done", {
          status: "completed",
          input: { command: "true" },
          output: "ok",
          metadata: {},
          time: { start: 1500, end: 1600 },
        }),
      },
    ])
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(MessageTable)
    .values({
      id: MessageID.make("msg_stale_incomplete"),
      session_id: staleID,
      time_created: 1000,
      time_updated: 1000,
      data: {
        role: "assistant",
        agent: "build",
        modelID: "model",
        providerID: "provider",
        mode: "primary",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1000 },
        parentID: "msg_stale_parent",
      } as NonNullable<(typeof MessageTable.$inferInsert)["data"]>,
    })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(PartTable)
    .values({
      id: PartID.make("prt_stale_running"),
      message_id: MessageID.make("msg_stale_incomplete"),
      session_id: staleID,
      time_created: 1000,
      time_updated: 2000,
      data: toolPart("stale", { status: "running", input: { command: "sleep 999" }, time: { start: 1500 } }),
    })
    .run()
    .pipe(Effect.orDie)
  return { sessionID, staleID }
})

describe("session.crashRecovery", () => {
  it.instance(
    "finalizes orphaned assistant messages and marks orphaned tool parts interrupted",
    () =>
      Effect.gen(function* () {
        const { sessionID, staleID } = yield* seed
        const { db } = yield* Database.Service

        const asAssistant = (info: (typeof MessageTable.$inferSelect)["data"]) =>
          info.role === "assistant" ? (info as Extract<SessionV1.Info, { role: "assistant" }>) : undefined
        const asTool = (part: (typeof PartTable.$inferSelect)["data"]) =>
          part.type === "tool" && "state" in part
            ? (part as Extract<SessionV1.Part, { type: "tool" }>)
            : undefined

        const repaired = yield* SessionCrashRecovery.sweep(db)
        expect(repaired).toEqual({ messages: 1, parts: 2 })

        const staleMessages = yield* db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.session_id, staleID))
          .all()
          .pipe(Effect.orDie)
        const staleIncomplete = staleMessages.find((message) => message.id === "msg_stale_incomplete")
        const staleInfo = staleIncomplete ? asAssistant(staleIncomplete.data) : undefined
        expect(staleInfo?.time.completed).toBeUndefined()
        const staleParts = yield* db
          .select()
          .from(PartTable)
          .where(eq(PartTable.session_id, staleID))
          .all()
          .pipe(Effect.orDie)
        const staleTool = staleParts.find((part) => part.id === "prt_stale_running")
        expect(staleTool ? asTool(staleTool.data)?.state.status : undefined).toBe("running")

        const messages = yield* db
          .select()
          .from(MessageTable)
          .where(eq(MessageTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        const byMessageId = new Map(messages.map((message) => [message.id as string, message]))

        const incomplete = byMessageId.get("msg_crash_incomplete")
        const incompleteInfo = incomplete ? asAssistant(incomplete.data) : undefined
        expect(incompleteInfo?.role).toBe("assistant")
        if (!incompleteInfo) return
        expect(incompleteInfo.time.completed).toBeGreaterThan(0)
        expect(incompleteInfo.error?.name).toBe("MessageAbortedError")

        const done = byMessageId.get("msg_crash_done")
        const doneInfo = done ? asAssistant(done.data) : undefined
        if (!doneInfo) return
        expect(doneInfo.time.completed).toBe(1002)
        expect(doneInfo.error).toBeUndefined()

        const parts = yield* db.select().from(PartTable).where(eq(PartTable.session_id, sessionID)).all().pipe(
          Effect.orDie,
        )
        const byId = new Map(parts.map((part) => [part.id as string, part]))

        const running = byId.get("prt_crash_running")
        const runningTool = running ? asTool(running.data) : undefined
        expect(runningTool?.state.status).toBe("error")
        if (runningTool?.state.status !== "error") return
        expect(runningTool.state.metadata?.interrupted).toBe(true)
        expect(runningTool.state.time.start).toBe(1500)
        expect(runningTool.state.time.end).toBeGreaterThan(0)
        expect(running?.time_updated).toBeGreaterThan(2000)

        const pending = byId.get("prt_crash_pending")
        const pendingTool = pending ? asTool(pending.data) : undefined
        if (pendingTool?.state.status !== "error") return
        expect(pendingTool.state.metadata?.interrupted).toBe(true)
        expect(pendingTool.state.time.start).toBe(2000)

        const finished = byId.get("prt_crash_done")
        const finishedTool = finished ? asTool(finished.data) : undefined
        expect(finishedTool?.state.status).toBe("completed")

        expect(yield* SessionCrashRecovery.sweep(db)).toEqual({ messages: 0, parts: 0 })
      }),
  )
})
