export * as SessionCrashRecovery from "./crash-recovery"

import { and, eq, sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { MessageTable, PartTable, SessionTable } from "./sql"
import { SessionV1 } from "../v1/session"

// Boot-time cost scales with total history (hundreds of thousands of rows),
// so only sessions touched in the last day are scanned; older artifacts are
// left alone.
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

// The stored data columns collapse the message/part unions (Omit over a union
// keeps only shared keys), so narrow back to the variants this sweep rewrites.
type StoredMessageData = Omit<SessionV1.Info, "id" | "sessionID">
type StoredPartData = Omit<SessionV1.Part, "id" | "sessionID" | "messageID">
type AssistantInfoData = Extract<SessionV1.Info, { role: "assistant" }>
type ToolPartData = Extract<SessionV1.Part, { type: "tool" }>

const asAssistant = (info: StoredMessageData): AssistantInfoData | undefined =>
  info.role === "assistant" ? (info as AssistantInfoData) : undefined

const asTool = (part: StoredPartData): ToolPartData | undefined =>
  part.type === "tool" && "state" in part ? (part as ToolPartData) : undefined

// After an unclean shutdown the durable projections still look like live work:
// assistant messages without a completion time and tool parts stuck in
// pending/running. The process that would have settled them is gone, so the
// timeline reports the session as in flight forever ("Waiting for bash to
// finish") and later turns inherit stale state. At boot no drain exists yet,
// so every such row is orphaned. Mark them exactly the way an interrupt would
// (MessageAbortedError on the message, metadata.interrupted on the tool part)
// so existing orphan handling takes over. This only cleans artifacts; it never
// retries provider work.
export const sweep = Effect.fn("SessionCrashRecovery.sweep")(function* (db: Database.Interface["db"]) {
    const now = Date.now()
    const cutoff = now - RECENT_WINDOW_MS

    const messages = yield* db
      .select({ id: MessageTable.id, data: MessageTable.data })
      .from(SessionTable)
      .crossJoin(MessageTable)
      .where(
        and(
          eq(MessageTable.session_id, SessionTable.id),
          sql`max(${SessionTable.time_updated}, ${SessionTable.time_created}) >= ${cutoff}`,
          sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
          sql`json_extract(${MessageTable.data}, '$.time.completed') is null`,
        ),
      )
      .all()
      .pipe(Effect.orDie)
    for (const row of messages) {
      const info = asAssistant(row.data)
      if (!info) continue
      info.time.completed = now
      info.error ??= new SessionV1.AbortedError({ message: "Aborted" })
      yield* db
        .update(MessageTable)
        .set({ data: info, time_updated: now })
        .where(eq(MessageTable.id, row.id))
        .run()
        .pipe(Effect.orDie)
    }

    const parts = yield* db
      .select({ id: PartTable.id, time_updated: PartTable.time_updated, data: PartTable.data })
      .from(SessionTable)
      .crossJoin(PartTable)
      .where(
        and(
          eq(PartTable.session_id, SessionTable.id),
          sql`max(${SessionTable.time_updated}, ${SessionTable.time_created}) >= ${cutoff}`,
          sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
          sql`json_extract(${PartTable.data}, '$.state.status') in ('pending', 'running')`,
        ),
      )
      .all()
      .pipe(Effect.orDie)
    for (const row of parts) {
      const part = asTool(row.data)
      if (!part) continue
      const state: SessionV1.ToolStateError = {
        status: "error",
        input: part.state.input,
        error: "aborted: opencode stopped before this tool call finished, its result is unknown; re-run if needed",
        metadata: {
          ...(part.state.status === "running" ? part.state.metadata : undefined),
          interrupted: true,
        },
        time: { start: part.state.status === "running" ? part.state.time.start : row.time_updated, end: now },
      }
      const data = { ...part, state } as typeof PartTable.$inferInsert.data
      yield* db
        .update(PartTable)
        .set({ data, time_updated: now })
        .where(eq(PartTable.id, row.id))
        .run()
        .pipe(Effect.orDie)
    }

    if (messages.length > 0 || parts.length > 0)
      yield* Effect.logInfo("crash recovery finalized orphaned session artifacts", {
        messages: messages.length,
        parts: parts.length,
      })
    return { messages: messages.length, parts: parts.length }
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* sweep(db)
  }),
)

export const node = makeGlobalNode({ name: "session-crash-recovery", layer, deps: [Database.node] })
