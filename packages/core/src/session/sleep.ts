export * as SessionSleep from "./sleep"

import { and, desc, eq, isNull, lte, or, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { Identifier } from "../id/id"
import { statics } from "../schema"
import type { MessageID } from "../v1/session"
import { SessionSchema } from "./schema"
import { SessionSleepTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export type Status = "pending" | "fired" | "timed_out" | "failed" | "cancelled"

/** Statuses whose wake message must still be delivered to the session. */
const UNDELIVERED: readonly Status[] = ["fired", "timed_out", "failed"]

/** Delivery attempts before redelivery gives up and only logs. */
export const MAX_DELIVER_ATTEMPTS = 5

export const ID = Schema.String.pipe(
  Schema.brand("SessionSleep.ID"),
  statics((schema) => ({ ascending: () => schema.make(Identifier.ascending("sleep")) })),
)
export type ID = Schema.Schema.Type<typeof ID>

export interface Trigger {
  readonly id: ID
  readonly sessionID: SessionSchema.ID
  readonly condition: string
  readonly description: string
  readonly intervalMs: number
  readonly checkTimeoutMs: number
  /** Epoch ms; the trigger wakes with a timeout notice after this point. */
  readonly deadline: number
  readonly cwd: string
  readonly shell?: string
  readonly nextCheckAt: number
  readonly consecutiveFailures: number
  readonly lastOutput?: string
  readonly status: Status
  readonly messageID?: string
  readonly deliveredAt?: number
  readonly deliverAttempts: number
  readonly timeCreated: number
  readonly timeFinished?: number
}

type Row = typeof SessionSleepTable.$inferSelect

const fromRow = (row: Row): Trigger => ({
  id: ID.make(row.id),
  sessionID: SessionSchema.ID.make(row.session_id),
  condition: row.condition,
  description: row.description,
  intervalMs: row.interval_ms,
  checkTimeoutMs: row.check_timeout_ms,
  deadline: row.deadline,
  cwd: row.cwd,
  ...(row.shell === null ? {} : { shell: row.shell }),
  nextCheckAt: row.next_check_at,
  consecutiveFailures: row.consecutive_failures,
  ...(row.last_output === null ? {} : { lastOutput: row.last_output }),
  status: row.status,
  ...(row.message_id === null ? {} : { messageID: row.message_id }),
  ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
  deliverAttempts: row.deliver_attempts,
  timeCreated: row.time_created,
  ...(row.time_finished === null ? {} : { timeFinished: row.time_finished }),
})

/**
 * Arms a trigger. One armed trigger per session: any previous pending row is
 * cancelled so re-arming from the LLM always has replace semantics.
 */
export const arm = Effect.fn("SessionSleep.arm")(function* (
  db: DatabaseService,
  input: {
    readonly id: ID
    readonly sessionID: SessionSchema.ID
    readonly condition: string
    readonly description: string
    readonly intervalMs: number
    readonly checkTimeoutMs: number
    readonly deadline: number
    readonly cwd: string
    readonly shell?: string
    readonly nextCheckAt: number
  },
) {
  const now = Date.now()
  yield* db
    .update(SessionSleepTable)
    .set({ status: "cancelled", time_finished: now, time_updated: now })
    .where(and(eq(SessionSleepTable.session_id, input.sessionID), eq(SessionSleepTable.status, "pending")))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionSleepTable)
    .values({
      id: input.id,
      session_id: input.sessionID,
      condition: input.condition,
      description: input.description,
      interval_ms: input.intervalMs,
      check_timeout_ms: input.checkTimeoutMs,
      deadline: input.deadline,
      cwd: input.cwd,
      ...(input.shell === undefined ? {} : { shell: input.shell }),
      next_check_at: input.nextCheckAt,
      status: "pending",
      time_created: now,
      time_updated: now,
    })
    .run()
    .pipe(Effect.orDie)
  const row = yield* db.select().from(SessionSleepTable).where(eq(SessionSleepTable.id, input.id)).get().pipe(
    Effect.orDie,
  )
  return fromRow(row!)
})

/** Most recent trigger for a session, regardless of status. */
export const get = Effect.fn("SessionSleep.get")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const row = yield* db
    .select()
    .from(SessionSleepTable)
    .where(eq(SessionSleepTable.session_id, sessionID))
    .orderBy(desc(SessionSleepTable.time_created))
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

export const cancel = Effect.fn("SessionSleep.cancel")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const now = Date.now()
  const claimed = yield* db
    .update(SessionSleepTable)
    .set({ status: "cancelled", time_finished: now, time_updated: now })
    .where(
      and(
        eq(SessionSleepTable.session_id, sessionID),
        eq(SessionSleepTable.status, "pending"),
        isNull(SessionSleepTable.delivered_at),
      ),
    )
    .returning({ id: SessionSleepTable.id })
    .get()
    .pipe(Effect.orDie)
  return claimed !== undefined
})

/** Pending triggers whose check is due at or before `now`. */
export const due = Effect.fn("SessionSleep.due")(function* (db: DatabaseService, now: number, limit = 64) {
  const rows = yield* db
    .select()
    .from(SessionSleepTable)
    .where(and(eq(SessionSleepTable.status, "pending"), lte(SessionSleepTable.next_check_at, now)))
    .orderBy(SessionSleepTable.next_check_at)
    .limit(limit)
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

/**
 * Atomically claims a due check by advancing `next_check_at`. Whichever
 * scheduler wins the claim runs the check and the losers skip. Row-level
 * claims are what make multiple schedulers — duplicated layer copies, TUI
 * plus server processes, future clustered placement — safe against double
 * polling, rather than any single-instance assumption.
 */
export const claimCheck = Effect.fn("SessionSleep.claimCheck")(function* (db: DatabaseService, id: ID, now: number) {
  const claimed = yield* db
    .update(SessionSleepTable)
    .set({ next_check_at: sql`${now} + ${SessionSleepTable.interval_ms}`, time_updated: now })
    .where(
      and(
        eq(SessionSleepTable.id, id),
        eq(SessionSleepTable.status, "pending"),
        lte(SessionSleepTable.next_check_at, now),
      ),
    )
    .returning({ id: SessionSleepTable.id })
    .get()
    .pipe(Effect.orDie)
  return claimed !== undefined
})

export const recordNotMet = Effect.fn("SessionSleep.recordNotMet")(function* (
  db: DatabaseService,
  id: ID,
  lastOutput: string,
) {
  const now = Date.now()
  yield* db
    .update(SessionSleepTable)
    .set({ consecutive_failures: 0, last_output: lastOutput, time_updated: now })
    .where(eq(SessionSleepTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

/** Counts a failed check; returns the new consecutive failure count. */
export const recordFailure = Effect.fn("SessionSleep.recordFailure")(function* (
  db: DatabaseService,
  id: ID,
  lastOutput: string,
) {
  const now = Date.now()
  const row = yield* db
    .update(SessionSleepTable)
    .set({
      consecutive_failures: sql`${SessionSleepTable.consecutive_failures} + 1`,
      last_output: lastOutput,
      time_updated: now,
    })
    .where(and(eq(SessionSleepTable.id, id), eq(SessionSleepTable.status, "pending")))
    .returning({ failures: SessionSleepTable.consecutive_failures })
    .get()
    .pipe(Effect.orDie)
  return row?.failures
})

/**
 * Terminal transition claim: exactly one caller wins per trigger, and the
 * winner owns wake delivery. `messageID` makes the eventual prompt admission
 * idempotent across crash-recovery redelivery.
 */
export const finish = Effect.fn("SessionSleep.finish")(function* (
  db: DatabaseService,
  id: ID,
  status: Exclude<Status, "pending" | "cancelled">,
  messageID: MessageID,
  lastOutput?: string,
) {
  const now = Date.now()
  const claimed = yield* db
    .update(SessionSleepTable)
    .set({
      status,
      message_id: messageID,
      ...(lastOutput === undefined ? {} : { last_output: lastOutput }),
      time_finished: now,
      time_updated: now,
    })
    .where(and(eq(SessionSleepTable.id, id), eq(SessionSleepTable.status, "pending")))
    .returning({ id: SessionSleepTable.id })
    .get()
    .pipe(Effect.orDie)
  return claimed !== undefined
})

export const byID = Effect.fn("SessionSleep.byID")(function* (db: DatabaseService, id: ID) {
  const row = yield* db.select().from(SessionSleepTable).where(eq(SessionSleepTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

/**
 * Terminal triggers whose wake message was not confirmed delivered. The
 * scheduler rescans these every tick, so a crash between firing and delivery
 * self-heals with at-least-once semantics (the session-side admission is
 * idempotent per message ID).
 */
export const deliverable = Effect.fn("SessionSleep.deliverable")(function* (db: DatabaseService) {
  const rows = yield* db
    .select()
    .from(SessionSleepTable)
    .where(
      and(
        isNull(SessionSleepTable.delivered_at),
        lte(SessionSleepTable.deliver_attempts, MAX_DELIVER_ATTEMPTS),
        or(...UNDELIVERED.map((status) => eq(SessionSleepTable.status, status))),
      ),
    )
    .orderBy(SessionSleepTable.time_finished)
    .limit(64)
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})

/** Claims a delivery attempt; undefined means another scheduler is on it. */
export const claimDelivery = Effect.fn("SessionSleep.claimDelivery")(function* (db: DatabaseService, id: ID) {
  const now = Date.now()
  const claimed = yield* db
    .update(SessionSleepTable)
    .set({ delivered_at: now, deliver_attempts: sql`${SessionSleepTable.deliver_attempts} + 1` })
    .where(
      and(
        eq(SessionSleepTable.id, id),
        isNull(SessionSleepTable.delivered_at),
        lte(SessionSleepTable.deliver_attempts, MAX_DELIVER_ATTEMPTS),
      ),
    )
    .returning({ attempts: SessionSleepTable.deliver_attempts })
    .get()
    .pipe(Effect.orDie)
  return claimed !== undefined ? claimed.attempts : undefined
})

/** Frees a failed delivery claim so the next tick retries. */
export const releaseDelivery = Effect.fn("SessionSleep.releaseDelivery")(function* (db: DatabaseService, id: ID) {
  const now = Date.now()
  yield* db
    .update(SessionSleepTable)
    .set({ delivered_at: null, time_updated: now })
    .where(eq(SessionSleepTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

/** Marks a wake as observed by the session so repair passes stop retrying. */
export const confirmDelivery = Effect.fn("SessionSleep.confirmDelivery")(function* (db: DatabaseService, id: ID) {
  const now = Date.now()
  yield* db
    .update(SessionSleepTable)
    .set({ delivered_at: now, time_updated: now })
    .where(eq(SessionSleepTable.id, id))
    .run()
    .pipe(Effect.orDie)
})
