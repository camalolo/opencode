import { describe, expect, test } from "bun:test"
import { Cause, Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ScheduledTaskTable } from "@opencode-ai/core/task/sql"
import { TaskSchedule } from "@opencode-ai/core/task/schedule"
import { ScheduledTask } from "@opencode-ai/core/task/task"
import { Task } from "@opencode-ai/schema/task"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { tmpdir } from "./fixture/tmpdir"

const TEST_TIMEOUT = 30_000

const withDb = (body: (db: Database.Interface["db"]) => Effect.Effect<void, unknown>) => async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/test.sqlite`
  // layerFromPath applies pending migrations while building. Typed failures
  // bubble as rejections so bun reports the original error per test.
  await Effect.gen(function* () {
    const database = yield* Database.Service
    yield* body(database.db)
  })
    .pipe(
      Effect.catchCause((cause) => Effect.die(Cause.squash(cause))),
      Effect.provide(Database.layerFromPath(filename)),
      Effect.scoped,
      Effect.runPromise,
    )
}

const itDb = (name: string, body: (db: Database.Interface["db"]) => Effect.Effect<void, unknown>) =>
  test(name, withDb(body), TEST_TIMEOUT)

const DIRECTORY = "/tmp/task-test"

const createTask = (db: Database.Interface["db"], overrides: Partial<Parameters<typeof ScheduledTask.insert>[1]> = {}) =>
  ScheduledTask.insert(db, {
    directory: DIRECTORY,
    name: "sweep",
    cron: "0 7 * * *",
    prompt: "do the thing",
    ...overrides,
  })

describe("TaskSchedule", () => {
  test("rejects malformed cron and timezones", () => {
    expect(TaskSchedule.validate({ cron: "not a cron" })).toBeDefined()
    expect(TaskSchedule.validate({ cron: "61 * * * *" })).toBeDefined()
    expect(TaskSchedule.validate({ cron: "0 7 * * *", timezone: "Mars/Olympus" })).toBeDefined()
    expect(TaskSchedule.validate({ cron: "0 7 * * *" })).toBeUndefined()
  })

  test("nextAfter is strictly after the reference time", () => {
    const after = Date.UTC(2026, 0, 15, 6, 30, 0)
    const next = TaskSchedule.nextAfter({ cron: "0 7 * * *", after })
    expect(next).toBe(Date.UTC(2026, 0, 15, 7, 0, 0))
    const second = TaskSchedule.nextAfter({ cron: "0 7 * * *", after: next })
    expect(second).toBe(Date.UTC(2026, 0, 16, 7, 0, 0))
  })

  test("honors the task timezone and DST offsets", () => {
    // 2026-10-25 is the CET/CEST fall-back transition in Vienna (03:00 -> 02:00).
    const after = Date.UTC(2026, 9, 24, 12, 0, 0)
    const next = TaskSchedule.nextAfter({ cron: "30 4 * * *", timezone: "Europe/Vienna", after })
    expect(new Date(next).toISOString()).toBe("2026-10-25T03:30:00.000Z")
  })
})

describe("ScheduledTask", () => {
  itDb(
    "create computes the next fire time and enforces directory-scoped name uniqueness",
    (db) =>
      Effect.gen(function* () {
        const info = yield* createTask(db)
        expect(info.enabled).toBe(true)
        expect(info.nextRunAt).toBeGreaterThan(Date.now())
        expect(info.retainRuns).toBe(ScheduledTask.DefaultRetainRuns)

        const duplicate = yield* createTask(db, { name: "sweep" }).pipe(Effect.flip)
        expect(duplicate._tag).toBe("Task.DuplicateError")

        const otherDirectory = yield* createTask(db, { name: "sweep", directory: "/tmp/other" })
        expect(otherDirectory.id).not.toBe(info.id)

        const disabled = yield* createTask(db, { name: "off", enabled: false })
        expect(disabled.nextRunAt).toBeUndefined()
      }),
  )

  itDb(
    "update recomputes next_run_at on schedule change and re-enable",
    (db) =>
      Effect.gen(function* () {
        const info = yield* createTask(db)
        const updated = yield* ScheduledTask.updateTask(db, info.id, { cron: "30 4 * * *", timezone: "Europe/Vienna" })
        expect(updated.cron).toBe("30 4 * * *")
        expect(updated.timezone).toBe("Europe/Vienna")
        expect(updated.nextRunAt).toBeGreaterThan(Date.now())

        const disabled = yield* ScheduledTask.updateTask(db, info.id, { enabled: false })
        expect(disabled.enabled).toBe(false)
        expect(disabled.nextRunAt).toBeUndefined()

        const reenabled = yield* ScheduledTask.updateTask(db, info.id, { enabled: true })
        expect(reenabled.nextRunAt).toBeGreaterThan(Date.now())

        const invalid = yield* ScheduledTask.updateTask(db, info.id, { cron: "junk" }).pipe(Effect.flip)
        expect(invalid._tag).toBe("Task.InvalidScheduleError")

        const missing = yield* ScheduledTask.updateTask(db, Task.ID.make("task_missing"), { prompt: "x" }).pipe(
          Effect.flip,
        )
        expect(missing._tag).toBe("Task.NotFoundError")

        const untouched = yield* ScheduledTask.updateTask(db, info.id, { description: "unchanged schedule" })
        expect(untouched.nextRunAt).toBe(reenabled.nextRunAt)
      }),
  )

  itDb(
    "claimDue claims each due slot exactly once and skips tasks with an active run",
    (db) =>
      Effect.gen(function* () {
        const due = yield* createTask(db, { name: "due" })
        const slot = Date.now() - 1000
        yield* db
          .update(ScheduledTaskTable)
          .set({ next_run_at: slot })
          .where(eq(ScheduledTaskTable.id, due.id))
          .run()
          .pipe(Effect.orDie)

        const now = Date.now()
        const claimed = yield* ScheduledTask.claimDue(db, now)
        expect(claimed).toHaveLength(1)
        expect(claimed[0].task.id).toBe(due.id)
        expect(claimed[0].run.scheduledAt).toBe(slot)
        expect(claimed[0].run.status).toBe("pending")
        expect(claimed[0].run.trigger).toBe("schedule")
        expect(claimed[0].run.id.startsWith(`run_${due.id}_`)).toBe(true)

        // The slot is consumed: re-claiming at the same instant finds nothing.
        const again = yield* ScheduledTask.claimDue(db, now)
        expect(again).toHaveLength(0)

        // A disabled task is never claimed.
        yield* createTask(db, { name: "off", enabled: false })
        expect(yield* ScheduledTask.claimDue(db, Date.now())).toHaveLength(0)
      }),
  )

  itDb(
    "claimDue skips tasks whose previous run is still active",
    (db) =>
      Effect.gen(function* () {
        const busy = yield* createTask(db, { name: "busy" })
        const past = Date.now() - 60_000
        yield* db.update(ScheduledTaskTable).set({ next_run_at: past }).where(eq(ScheduledTaskTable.id, busy.id)).run()

        // Insert an active run directly so the skip branch is exercised.
        const active = yield* ScheduledTask.insertRun(db, { task: busy, scheduledAt: Date.now() })
        expect(active.status).toBe("pending")

        const claimed = yield* ScheduledTask.claimDue(db, Date.now())
        expect(claimed).toHaveLength(0)

        // The slot stays due; finishing the active run lets the next tick take it.
        yield* ScheduledTask.finishRun(db, active.id, "completed")
        const afterFinish = yield* ScheduledTask.claimDue(db, Date.now())
        expect(afterFinish).toHaveLength(1)
      }),
  )

  itDb(
    "startRun and finishRun arbitrate the run lifecycle",
    (db) =>
      Effect.gen(function* () {
        const info = yield* createTask(db, { name: "lifecycle" })
        const run = yield* ScheduledTask.insertRun(db, { task: info, scheduledAt: Date.now() })

        expect(yield* ScheduledTask.startRun(db, run.id)).toBe(true)
        expect(yield* ScheduledTask.startRun(db, run.id)).toBe(false)

        const finished = yield* ScheduledTask.finishRun(db, run.id, "failed", "boom")
        expect(finished?.status).toBe("failed")
        expect(finished?.error).toBe("boom")
        expect(finished?.timeCompleted).toBeDefined()

        const late = yield* ScheduledTask.finishRun(db, run.id, "completed")
        expect(late).toBeUndefined()

        // Terminal runs no longer count as active.
        expect(yield* ScheduledTask.activeRun(db, info.id)).toBeUndefined()
        const history = yield* ScheduledTask.runsForTask(db, info.id)
        expect(history).toHaveLength(1)
      }),
  )

  itDb(
    "overdueRuns surfaces running runs past their timeout and failRunning sweeps orphans",
    (db) =>
      Effect.gen(function* () {
        const info = yield* createTask(db, { name: "watchdog", runTimeoutMs: 1000 })
        const run = yield* ScheduledTask.insertRun(db, { task: info, scheduledAt: Date.now() })
        yield* ScheduledTask.startRun(db, run.id)
        yield* ScheduledTask.attachSession(db, run.id, SessionSchema.ID.make("ses_a"))

        expect(yield* ScheduledTask.overdueRuns(db, Date.now() + 2000)).toHaveLength(1)
        expect(yield* ScheduledTask.overdueRuns(db, Date.now())).toHaveLength(0)

        const swept = yield* ScheduledTask.failRunning(db, "interrupted: scheduler process exited")
        expect(swept).toHaveLength(1)
        const after = yield* ScheduledTask.byID(db, info.id)
        expect(after).toBeDefined()
        const history = yield* ScheduledTask.runsForTask(db, info.id)
        expect(history[0].status).toBe("failed")
        expect(history[0].error).toBe("interrupted: scheduler process exited")
      }),
  )

  itDb(
    "pruneRuns keeps the newest runs within retention",
    (db) =>
      Effect.gen(function* () {
        const info = yield* createTask(db, { name: "prune", retainRuns: 2 })
        for (let i = 0; i < 4; i++) {
          const run = yield* ScheduledTask.insertRun(db, { task: info, scheduledAt: Date.now() + i })
          yield* ScheduledTask.startRun(db, run.id)
          yield* ScheduledTask.finishRun(db, run.id, i % 2 === 0 ? "completed" : "failed")
        }
        yield* ScheduledTask.pruneRuns(db, info.id, 2)
        const history = yield* ScheduledTask.runsForTask(db, info.id)
        expect(history).toHaveLength(2)
      }),
  )
})
