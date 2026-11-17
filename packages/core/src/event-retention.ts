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

// Journal rowids ascend with insert order and event times track insert order,
// so everything older than the cutoff sits below a discoverable rowid
// boundary. Sweeps used to rescan the whole table instead: each batch select
// walked rowids forward until it filled 2000 matches (or hit the end), which
// in steady state read every remaining blob in the database — 60-90s per pass
// on the largest fleet database. Every statement serializes behind the
// database semaphore, so the whole server stalled with it on every boot and
// every sweep. A ~20-probe binary search finds the boundary instead, and the
// delete pass scans only the band below it. Only the search relies on the
// monotonic assumption: deletes still re-check the exact time predicate, so
// out-of-order journaling just widens what the margin band rescans, never
// what gets deleted.
const SKEW_MARGIN = 10_000

const timeAtOrAfter = Effect.fn("EventRetention.timeAtOrAfter")(function* (
  db: Database.Interface["db"],
  rowid: number,
) {
  const row = yield* db
    .select({ time: eventTime })
    .from(EventTable)
    .where(sql`rowid >= ${rowid}`)
    .orderBy(sql`rowid`)
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  // json_extract can yield null; a row without a usable stamp counts as
  // "found" so the boundary never moves past it and the delete pass, which
  // re-checks the predicate exactly, still runs over it.
  return typeof row?.time === "number" ? row.time : undefined
})

export const sweep = Effect.fn("EventRetention.sweep")(function* (db: Database.Interface["db"]) {
  const cutoff = Date.now() - RETENTION_MS
  const maxRow = yield* db
    .select({ m: sql<number>`max(rowid)` })
    .from(EventTable)
    .get()
    .pipe(Effect.orDie)
  const bound = maxRow?.m ?? 0
  if (bound === 0) return 0
  let lo = 1
  let hi = bound
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const time = yield* timeAtOrAfter(db, mid)
    if (time !== undefined && time >= cutoff) hi = mid
    else lo = mid + 1
  }
  const bandEnd = Math.min(bound, lo + SKEW_MARGIN)
  let cursor = 0
  let deleted = 0
  while (cursor <= bandEnd) {
    const rows = yield* db
      .select({ rowid: sql<number>`rowid` })
      .from(EventTable)
      .where(
        and(
          sql`rowid > ${cursor}`,
          sql`rowid <= ${bandEnd}`,
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
