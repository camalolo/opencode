export * as EventRetention from "./event-retention"

import { and, inArray, sql } from "drizzle-orm"
import { Effect, Layer, Schedule } from "effect"
import { Database } from "./database/database"
import { EventTable } from "./event/sql"
import { makeGlobalNode } from "./effect/app-node"

// Session events are journaled durably in the `event` table for EventV2
// replay, but nothing replays them today: the message/part/session
// projections are the system of record on disk, and the only explicit-seq
// publisher (prompt retry reconciliation) touches prompted/admitted events,
// which are never pruned. Part and message updates stream in per chunk, so
// their journal rows repeat the full payload and dominate database size (on
// the largest fleet database the journal was 6 GB of a 9 GB file). Prune
// those two types after the retention window; everything else is kept.
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000
const BATCH = 2000
const SWEEP_EVERY = "6 hours"
const PRUNED_TYPES = ["message.part.updated.1", "message.updated.1"]

// The pruned events stamp different fields: part updates carry a top-level
// time, message updates carry the info's update time.
const eventTime = sql`(coalesce(json_extract(${EventTable.data}, '$.time'), json_extract(${EventTable.data}, '$.info.time.updated')))`

export const sweep = Effect.fn("EventRetention.sweep")(function* (db: Database.Interface["db"]) {
  const cutoff = Date.now() - RETENTION_MS
  const maxRow = yield* db
    .select({ m: sql<number>`max(rowid)` })
    .from(EventTable)
    .get()
    .pipe(Effect.orDie)
  const bound = maxRow?.m ?? 0
  let cursor = 0
  let deleted = 0
  while (cursor < bound) {
    const rows = yield* db
      .select({ rowid: sql<number>`rowid` })
      .from(EventTable)
      .where(
        and(
          sql`rowid > ${cursor}`,
          inArray(EventTable.type, PRUNED_TYPES),
          sql`${eventTime} < ${cutoff}`,
        ),
      )
      .orderBy(sql`rowid`)
      .limit(BATCH)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) break
    cursor = rows[rows.length - 1]!.rowid
    yield* db
      .delete(EventTable)
      .where(sql`rowid in (${sql.join(rows.map((row) => sql`${row.rowid}`), sql`, `)})`)
      .run()
      .pipe(Effect.orDie)
    deleted += rows.length
    // A first-run backlog deletes hundreds of thousands of rows; breathing
    // between batches keeps the write lock available for foreground session
    // writes instead of monopolizing it (and the disk) for the whole pass.
    yield* Effect.sleep("200 millis")
    if (deleted % (BATCH * 10) === 0) yield* Effect.logInfo("event retention pruning", { deleted })
  }
  if (deleted > 0) yield* Effect.logInfo("event retention pruned journal rows", { deleted })
  return deleted
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* Effect
      .gen(function* () {
        yield* Effect.sleep("2 minutes")
        yield* sweep(db).pipe(Effect.repeat(Schedule.spaced(SWEEP_EVERY)))
      })
      .pipe(Effect.ignore, Effect.forkScoped)
  }),
)

export const node = makeGlobalNode({ name: "event-retention", layer, deps: [Database.node] })
