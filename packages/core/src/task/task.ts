export * as ScheduledTask from "./task"

import { and, desc, eq, inArray, lte, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Task } from "@opencode-ai/schema/task"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { VariantID } from "@opencode-ai/schema/model"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Location } from "../location"
import { AbsolutePath } from "../schema"
import { SessionSchema } from "../session/schema"
import { ScheduledTaskRunTable, ScheduledTaskTable } from "./sql"
import { InvalidScheduleError, TaskSchedule } from "./schedule"

export const Info = Task.Info
export type Info = typeof Info.Type
export const Run = Task.Run
export type Run = typeof Run.Type
export const RunID = Task.RunID
export type RunID = typeof Task.RunID.Type
export const Event = Task.Event

export { InvalidScheduleError }

/** Runs kept per task when `retainRuns` is not set. */
export const DefaultRetainRuns = 20

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Task.NotFoundError", {
  taskID: Task.ID,
}) {}

export class DuplicateError extends Schema.TaggedErrorClass<DuplicateError>()("Task.DuplicateError", {
  directory: AbsolutePath,
  name: Schema.String,
}) {}

/** Skip policy: a run is already pending or running for this task. */
export class ActiveRunError extends Schema.TaggedErrorClass<ActiveRunError>()("Task.ActiveRunError", {
  taskID: Task.ID,
  runID: RunID,
}) {}

export interface CreateInput {
  readonly name: string
  readonly description?: string | null
  readonly cron: string
  readonly timezone?: string | null
  readonly agent?: Agent.ID
  readonly model?: Model.Ref
  readonly prompt: string
  readonly enabled?: boolean
  readonly runTimeoutMs?: number | null
  readonly retainRuns?: number | null
}

export interface UpdateInput {
  readonly name?: string
  readonly description?: string | null
  readonly cron?: string
  readonly timezone?: string | null
  readonly agent?: string | null
  readonly model?: Model.Ref | null
  readonly prompt?: string
  readonly enabled?: boolean
  readonly runTimeoutMs?: number | null
  readonly retainRuns?: number | null
}

export interface Claimed {
  readonly task: Info
  readonly run: Run
}

export interface Delivered {
  readonly run: Run
  readonly task: Info
}

type TaskRow = typeof ScheduledTaskTable.$inferSelect
type RunRow = typeof ScheduledTaskRunTable.$inferSelect

const fromTaskRow = (row: TaskRow): Info => ({
  id: Task.ID.make(row.id),
  directory: AbsolutePath.make(row.directory),
  name: row.name,
  ...(row.description === null ? {} : { description: row.description }),
  cron: row.cron,
  ...(row.timezone === null ? {} : { timezone: row.timezone }),
  ...(row.agent === null ? {} : { agent: Agent.ID.make(row.agent) }),
  ...(row.model === null
    ? {}
    : {
        model: {
          id: Model.ID.make(row.model.id),
          providerID: Provider.ID.make(row.model.providerID),
          ...(row.model.variant === undefined ? {} : { variant: VariantID.make(row.model.variant) }),
        },
      }),
  prompt: row.prompt,
  enabled: row.enabled,
  ...(row.run_timeout_ms === null ? {} : { runTimeoutMs: row.run_timeout_ms }),
  retainRuns: row.retain_runs,
  ...(row.enabled ? { nextRunAt: row.next_run_at } : {}),
  timeCreated: row.time_created,
  timeUpdated: row.time_updated,
})

const fromRunRow = (row: RunRow): Run => ({
  id: Task.RunID.make(row.id),
  taskID: Task.ID.make(row.task_id),
  ...(row.session_id === null ? {} : { sessionID: SessionSchema.ID.make(row.session_id) }),
  status: row.status,
  trigger: row.trigger,
  scheduledAt: row.scheduled_at,
  ...(row.time_started === null ? {} : { timeStarted: row.time_started }),
  ...(row.time_completed === null ? {} : { timeCompleted: row.time_completed }),
  ...(row.error === null ? {} : { error: row.error }),
})

const modelJson = (model: Model.Ref) => ({
  id: model.id,
  providerID: model.providerID,
  ...(model.variant === undefined ? {} : { variant: model.variant }),
})

/**
 * Drizzle surfaces statement failures as a defect chain: EffectDrizzleQueryError
 * → Effect Cause → SqlError → native sqlite error. Walk every edge looking for
 * the uniqueness violation message; anything else is rethrown as-is.
 */
const findUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  for (const key of ["message", "cause", "error", "defect", "reasons"] as const) {
    const value = (error as Record<string, unknown>)[key]
    if (typeof value === "string") {
      if (value.includes("UNIQUE constraint failed")) return true
      continue
    }
    if (typeof value !== "object" || value === null) continue
    if (Array.isArray(value)) {
      for (const item of value) if (findUniqueViolation(item)) return true
      continue
    }
    if (findUniqueViolation(value)) return true
  }
  return false
}

/**
 * Deterministic run id per schedule slot: the insert itself is the multi-process
 * claim (same convention as sleep's idempotent message ids). Two schedulers
 * racing on the same due slot produce the same id and one insert wins.
 */
const scheduleSlotRunID = (taskID: Task.ID, scheduledAt: number) => Task.RunID.make(`run_${taskID}_${scheduledAt}`)

export const byID = Effect.fn("ScheduledTask.byID")(function* (db: Database.Interface["db"], id: Task.ID) {
  const row = yield* db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromTaskRow(row)
})

export const byDirectory = Effect.fn("ScheduledTask.byDirectory")(function* (
  db: Database.Interface["db"],
  directory: string,
) {
  const rows = yield* db
    .select()
    .from(ScheduledTaskTable)
    .where(eq(ScheduledTaskTable.directory, directory))
    .orderBy(ScheduledTaskTable.name)
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromTaskRow)
})

export const insert = Effect.fn("ScheduledTask.insert")(function* (
  db: Database.Interface["db"],
  input: { directory: string } & CreateInput,
) {
  const timezone = input.timezone ?? undefined
  const invalid = TaskSchedule.validate({ cron: input.cron, timezone })
  if (invalid) return yield* invalid
  const now = Date.now()
  const enabled = input.enabled ?? true
  const row: TaskRow = {
    id: Task.ID.create(),
    directory: input.directory,
    name: input.name,
    description: input.description ?? null,
    cron: input.cron,
    timezone: input.timezone ?? null,
    agent: input.agent ?? null,
    model: input.model ? modelJson(input.model) : null,
    prompt: input.prompt,
    enabled,
    run_timeout_ms: input.runTimeoutMs ?? null,
    retain_runs: input.retainRuns ?? DefaultRetainRuns,
    next_run_at: enabled
      ? TaskSchedule.nextAfter({ cron: input.cron, timezone, after: now })
      : 0,
    time_created: now,
    time_updated: now,
  }
  yield* db
    .insert(ScheduledTaskTable)
    .values(row)
    .run()
    .pipe(
      Effect.catch((error) =>
        findUniqueViolation(error)
          ? Effect.fail(new DuplicateError({ directory: AbsolutePath.make(input.directory), name: input.name }))
          : Effect.die(error),
      ),
    )
  return fromTaskRow(row)
})

export const updateTask = Effect.fn("ScheduledTask.updateTask")(function* (
  db: Database.Interface["db"],
  id: Task.ID,
  input: UpdateInput,
) {
  const current = yield* db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, id)).get().pipe(
    Effect.orDie,
  )
  if (!current) return yield* new NotFoundError({ taskID: id })
  const cron = input.cron ?? current.cron
  const timezone = input.timezone === undefined ? current.timezone : input.timezone
  const invalid = TaskSchedule.validate({ cron, timezone: timezone ?? undefined })
  if (invalid) return yield* invalid
  const enabled = input.enabled ?? current.enabled
  const scheduleChanged = input.cron !== undefined || input.timezone !== undefined
  const now = Date.now()
  // Recompute the next fire when the schedule moves or the task is re-enabled;
  // an already-future next_run_at survives unrelated edits.
  const nextRunAt =
    enabled && (scheduleChanged || !current.enabled)
      ? TaskSchedule.nextAfter({ cron, timezone: timezone ?? undefined, after: now })
      : current.next_run_at
  const updated: TaskRow = {
    ...current,
    name: input.name ?? current.name,
    description: input.description === undefined ? current.description : input.description,
    cron,
    timezone,
    agent: input.agent === undefined ? current.agent : input.agent,
    model: input.model === undefined ? current.model : input.model === null ? null : modelJson(input.model),
    prompt: input.prompt ?? current.prompt,
    enabled,
    run_timeout_ms: input.runTimeoutMs === undefined ? current.run_timeout_ms : input.runTimeoutMs,
    retain_runs:
      input.retainRuns === undefined ? current.retain_runs : (input.retainRuns ?? DefaultRetainRuns),
    next_run_at: nextRunAt,
    time_updated: now,
  }
  yield* db
    .update(ScheduledTaskTable)
    .set(updated)
    .where(eq(ScheduledTaskTable.id, id))
    .run()
    .pipe(
      Effect.catch((error) =>
        findUniqueViolation(error)
          ? Effect.fail(new DuplicateError({ directory: AbsolutePath.make(current.directory), name: updated.name }))
          : Effect.die(error),
      ),
    )
  return fromTaskRow(updated)
})

export const removeTask = Effect.fn("ScheduledTask.removeTask")(function* (db: Database.Interface["db"], id: Task.ID) {
  const deleted = yield* db
    .delete(ScheduledTaskTable)
    .where(eq(ScheduledTaskTable.id, id))
    .returning({ id: ScheduledTaskTable.id })
    .get()
    .pipe(Effect.orDie)
  return deleted !== undefined
})

/**
 * Claims every due enabled task: inserts the run row (the atomic claim) and
 * advances `next_run_at` past `now`, so periods missed while the server was
 * down collapse into a single catch-up run. Skip policy: a task whose previous
 * run is still pending or running is left untouched — its stale slot stays due
 * and fires as catch-up once the active run finishes.
 */
export const claimDue = Effect.fn("ScheduledTask.claimDue")(function* (db: Database.Interface["db"], now: number) {
  const due = yield* db
    .select()
    .from(ScheduledTaskTable)
    .where(and(eq(ScheduledTaskTable.enabled, true), lte(ScheduledTaskTable.next_run_at, now)))
    .all()
    .pipe(Effect.orDie)
  const claimed: Claimed[] = []
  for (const task of due) {
    const scheduledAt = task.next_run_at
    const runID = scheduleSlotRunID(Task.ID.make(task.id), scheduledAt)
    const inserted = yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          const active = yield* tx
            .select({ id: ScheduledTaskRunTable.id })
            .from(ScheduledTaskRunTable)
            .where(
              and(
                eq(ScheduledTaskRunTable.task_id, Task.ID.make(task.id)),
                inArray(ScheduledTaskRunTable.status, ["pending", "running"]),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (active) return undefined
          const won = yield* tx
            .insert(ScheduledTaskRunTable)
            .values({
              id: runID,
              task_id: Task.ID.make(task.id),
              status: "pending",
              trigger: "schedule",
              scheduled_at: scheduledAt,
              time_created: now,
            })
            .onConflictDoNothing()
            .returning({ id: ScheduledTaskRunTable.id })
            .get()
            .pipe(Effect.orDie)
          if (!won) return undefined
          yield* tx
            .update(ScheduledTaskTable)
            .set({
              next_run_at: TaskSchedule.nextAfter({ cron: task.cron, timezone: task.timezone ?? undefined, after: now }),
              time_updated: now,
            })
            .where(eq(ScheduledTaskTable.id, task.id))
            .run()
            .pipe(Effect.orDie)
          return won.id
        }),
      )
      .pipe(Effect.orDie)
    if (inserted === undefined) continue
    claimed.push({
      task: fromTaskRow(task),
      run: {
        id: runID,
        taskID: Task.ID.make(task.id),
        status: "pending",
        trigger: "schedule",
        scheduledAt,
      },
    })
  }
  return claimed
})

/** Ad-hoc run (manual trigger). Insert-only: the scheduler's pending scan delivers it. */
export const insertRun = Effect.fn("ScheduledTask.insertRun")(function* (
  db: Database.Interface["db"],
  input: { task: Info; scheduledAt: number },
) {
  const active = yield* activeRun(db, input.task.id)
  if (active) return yield* new ActiveRunError({ taskID: input.task.id, runID: active.id })
  const id = Task.RunID.create()
  yield* db
    .insert(ScheduledTaskRunTable)
    .values({
      id,
      task_id: input.task.id,
      session_id: null,
      status: "pending",
      trigger: "manual",
      scheduled_at: input.scheduledAt,
      time_created: input.scheduledAt,
    })
    .run()
    .pipe(Effect.orDie)
  const run: Run = {
    id,
    taskID: input.task.id,
    status: "pending",
    trigger: "manual",
    scheduledAt: input.scheduledAt,
  }
  return run
})

/** Pending runs across all tasks with their task — the delivery queue. */
export const pendingRuns = Effect.fn("ScheduledTask.pendingRuns")(function* (db: Database.Interface["db"]) {
  const rows = yield* db
    .select({ run: ScheduledTaskRunTable, task: ScheduledTaskTable })
    .from(ScheduledTaskRunTable)
    .innerJoin(ScheduledTaskTable, eq(ScheduledTaskRunTable.task_id, ScheduledTaskTable.id))
    .where(eq(ScheduledTaskRunTable.status, "pending"))
    .orderBy(ScheduledTaskRunTable.time_created)
    .all()
    .pipe(Effect.orDie)
  return rows.map((row) => ({ run: fromRunRow(row.run), task: fromTaskRow(row.task) }))
})

/**
 * Delivery-time claim: pending → running. Exactly one scheduler wins; the
 * losers skip without touching the session.
 */
export const startRun = Effect.fn("ScheduledTask.startRun")(function* (db: Database.Interface["db"], id: RunID) {
  const now = Date.now()
  const claimed = yield* db
    .update(ScheduledTaskRunTable)
    .set({ status: "running", time_started: now })
    .where(and(eq(ScheduledTaskRunTable.id, id), eq(ScheduledTaskRunTable.status, "pending")))
    .returning({ id: ScheduledTaskRunTable.id })
    .get()
    .pipe(Effect.orDie)
  return claimed !== undefined
})

export const attachSession = Effect.fn("ScheduledTask.attachSession")(function* (
  db: Database.Interface["db"],
  id: RunID,
  sessionID: SessionSchema.ID,
) {
  yield* db
    .update(ScheduledTaskRunTable)
    .set({ session_id: sessionID })
    .where(eq(ScheduledTaskRunTable.id, id))
    .run()
    .pipe(Effect.orDie)
})

/**
 * Terminal transition claim: only wins from pending or running, so a late
 * delivery fiber cannot clobber a watchdog or restart verdict.
 */
export const finishRun = Effect.fn("ScheduledTask.finishRun")(function* (
  db: Database.Interface["db"],
  id: RunID,
  status: Exclude<Task.RunStatus, "pending" | "running">,
  error?: string,
) {
  const now = Date.now()
  const row = yield* db
    .update(ScheduledTaskRunTable)
    .set({
      status,
      time_completed: now,
      ...(error === undefined ? {} : { error }),
    })
    .where(
      and(
        eq(ScheduledTaskRunTable.id, id),
        inArray(ScheduledTaskRunTable.status, ["pending", "running"]),
      ),
    )
    .returning()
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : fromRunRow(row)
})

/** Every task, any directory — scheduler bookkeeping (pruning). */
export const all = Effect.fn("ScheduledTask.all")(function* (db: Database.Interface["db"]) {
  const rows = yield* db.select().from(ScheduledTaskTable).orderBy(ScheduledTaskTable.name).all().pipe(Effect.orDie)
  return rows.map(fromTaskRow)
})

/** Most recent runs for a task, newest first. */
export const runsForTask = Effect.fn("ScheduledTask.runsForTask")(function* (
  db: Database.Interface["db"],
  taskID: Task.ID,
  limit = 100,
) {
  const rows = yield* db
    .select()
    .from(ScheduledTaskRunTable)
    .where(eq(ScheduledTaskRunTable.task_id, taskID))
    .orderBy(desc(ScheduledTaskRunTable.time_created))
    .limit(limit)
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRunRow)
})

export const activeRun = Effect.fn("ScheduledTask.activeRun")(function* (db: Database.Interface["db"], taskID: Task.ID) {
  const row = yield* db
    .select()
    .from(ScheduledTaskRunTable)
    .where(and(eq(ScheduledTaskRunTable.task_id, taskID), inArray(ScheduledTaskRunTable.status, ["pending", "running"])))
    .orderBy(desc(ScheduledTaskRunTable.time_created))
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : fromRunRow(row)
})

/** Running runs that exceeded their task's configured timeout. */
export const overdueRuns = Effect.fn("ScheduledTask.overdueRuns")(function* (db: Database.Interface["db"], now: number) {
  const rows = yield* db
    .select({ run: ScheduledTaskRunTable, task: ScheduledTaskTable })
    .from(ScheduledTaskRunTable)
    .innerJoin(ScheduledTaskTable, eq(ScheduledTaskRunTable.task_id, ScheduledTaskTable.id))
    .where(eq(ScheduledTaskRunTable.status, "running"))
    .all()
    .pipe(Effect.orDie)
  return rows
    .filter(
      (row) =>
        row.task.run_timeout_ms !== null &&
        row.run.time_started !== null &&
        row.run.time_started + row.task.run_timeout_ms < now,
    )
    .map((row) => ({ run: fromRunRow(row.run), task: fromTaskRow(row.task) }))
})

/**
 * Boot sweep: runs left `running` by a dead process cannot finish on their own
 * (the drain fiber died with it), so the next scheduler start fails them.
 * Known limitation: a second live scheduler process (e.g. an embedded TUI
 * worker) booting mid-run marks the run failed while the session continues.
 */
export const failRunning = Effect.fn("ScheduledTask.failRunning")(function* (db: Database.Interface["db"], error: string) {
  const now = Date.now()
  const failed = yield* db
    .update(ScheduledTaskRunTable)
    .set({ status: "failed", error, time_completed: now })
    .where(eq(ScheduledTaskRunTable.status, "running"))
    .returning({ id: ScheduledTaskRunTable.id })
    .all()
    .pipe(Effect.orDie)
  return failed.map((row) => Task.RunID.make(row.id))
})

/** Deletes run history beyond the retention window, oldest first. */
export const pruneRuns = Effect.fn("ScheduledTask.pruneRuns")(function* (
  db: Database.Interface["db"],
  taskID: Task.ID,
  retain: number,
) {
  yield* db
    .run(
      sql`DELETE FROM ${ScheduledTaskRunTable} WHERE task_id = ${taskID} AND id NOT IN (SELECT id FROM ${ScheduledTaskRunTable} WHERE task_id = ${taskID} ORDER BY time_created DESC, id DESC LIMIT ${retain})`,
    )
    .pipe(Effect.orDie)
})

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (taskID: Task.ID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: CreateInput) => Effect.Effect<Info, InvalidScheduleError | DuplicateError>
  readonly update: (
    taskID: Task.ID,
    input: UpdateInput,
  ) => Effect.Effect<Info, NotFoundError | InvalidScheduleError | DuplicateError>
  readonly remove: (taskID: Task.ID) => Effect.Effect<boolean, NotFoundError>
  readonly trigger: (taskID: Task.ID) => Effect.Effect<Run, NotFoundError | ActiveRunError>
  readonly runs: (taskID: Task.ID) => Effect.Effect<Run[], NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ScheduledTask") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const location = yield* Location.Service

    const scoped = Effect.fn("ScheduledTask.scoped")(function* (taskID: Task.ID) {
      const row = yield* db.select().from(ScheduledTaskTable).where(eq(ScheduledTaskTable.id, taskID)).get().pipe(
        Effect.orDie,
      )
      if (!row || row.directory !== location.directory) return yield* new NotFoundError({ taskID })
      return fromTaskRow(row)
    })

    const publish = Effect.fn("ScheduledTask.publish")(function* (info: Info) {
      yield* events.publish(Event.Updated, { task: info })
    })

    const list: Interface["list"] = Effect.fn("ScheduledTask.list")(function* () {
      return yield* byDirectory(db, location.directory)
    })

    const get: Interface["get"] = (taskID) => scoped(taskID)

    const create: Interface["create"] = Effect.fn("ScheduledTask.create")(function* (input) {
      const info = yield* insert(db, { ...input, directory: location.directory })
      yield* publish(info)
      return info
    })

    const update: Interface["update"] = Effect.fn("ScheduledTask.updateEntry")(function* (taskID, input) {
      yield* scoped(taskID)
      const info = yield* updateTask(db, taskID, input)
      yield* publish(info)
      return info
    })

    const remove: Interface["remove"] = Effect.fn("ScheduledTask.removeEntry")(function* (taskID) {
      yield* scoped(taskID)
      return yield* removeTask(db, taskID)
    })

    const trigger: Interface["trigger"] = Effect.fn("ScheduledTask.trigger")(function* (taskID) {
      const info = yield* scoped(taskID)
      const run = yield* insertRun(db, { task: info, scheduledAt: Date.now() })
      yield* events.publish(Event.RunUpdated, { run }, { location: { directory: info.directory } })
      return run
    })

    const runs: Interface["runs"] = Effect.fn("ScheduledTask.runs")(function* (taskID) {
      yield* scoped(taskID)
      return yield* runsForTask(db, taskID)
    })

    return Service.of({ list, get, create, update, remove, trigger, runs })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, Location.node],
})
