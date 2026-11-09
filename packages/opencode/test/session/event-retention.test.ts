import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { EventRetention } from "@opencode-ai/core/event-retention"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { ID } from "@opencode-ai/core/event"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node])))

const DAY = 24 * 60 * 60 * 1000

const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const aggregate = "ses_retention_test"
  yield* db
    .insert(EventSequenceTable)
    .values({ aggregate_id: aggregate, seq: 0 })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  let seq = 0
  const rows: (typeof EventTable.$inferInsert)[] = [
    {
      id: ID.make("evt_ret_old_part"),
      aggregate_id: aggregate,
      seq: seq++,
      type: "message.part.updated.1",
      data: { sessionID: aggregate, part: {}, time: Date.now() - 30 * DAY },
    },
    {
      id: ID.make("evt_ret_new_part"),
      aggregate_id: aggregate,
      seq: seq++,
      type: "message.part.updated.1",
      data: { sessionID: aggregate, part: {}, time: Date.now() - 1 * DAY },
    },
    {
      id: ID.make("evt_ret_old_msg"),
      aggregate_id: aggregate,
      seq: seq++,
      type: "message.updated.1",
      data: { sessionID: aggregate, info: { time: { updated: Date.now() - 30 * DAY } } },
    },
    {
      id: ID.make("evt_ret_old_session"),
      aggregate_id: aggregate,
      seq: seq++,
      type: "session.updated.1",
      data: { sessionID: aggregate, info: { time: { updated: Date.now() - 30 * DAY } } },
    },
  ]
  yield* db.insert(EventTable).values(rows).run().pipe(Effect.orDie)
  return { aggregate, ids: rows.map((row) => row.id!) }
})

describe("event.retention", () => {
  it.instance(
    "prunes old part/message journal rows and keeps everything else",
    () =>
      Effect.gen(function* () {
        const { aggregate, ids } = yield* seed
        const { db } = yield* Database.Service

        const deleted = yield* EventRetention.sweep(db)
        expect(deleted).toBe(2)

        const left = yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, aggregate))
          .all()
          .pipe(Effect.orDie)
        const remaining = new Set(left.map((row) => row.id))
        expect(remaining.has(ID.make("evt_ret_old_part"))).toBe(false)
        expect(remaining.has(ID.make("evt_ret_old_msg"))).toBe(false)
        expect(remaining.has(ID.make("evt_ret_new_part"))).toBe(true)
        expect(remaining.has(ID.make("evt_ret_old_session"))).toBe(true)

        expect(yield* EventRetention.sweep(db)).toBe(0)
        void ids
      }),
  )
})
