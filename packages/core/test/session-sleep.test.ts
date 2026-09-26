import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSleep } from "@opencode-ai/core/session/sleep"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID } from "@opencode-ai/core/v1/session"
import { tmpdir } from "./fixture/tmpdir"

const insertSession = (db: Database.Interface["db"], sessionID: string) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({
        id: ProjectV2.ID.make(`prj_${sessionID}`),
        worktree: AbsolutePath.make("/tmp/test"),
        name: "test",
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make(sessionID),
        project_id: ProjectV2.ID.make(`prj_${sessionID}`),
        slug: sessionID,
        directory: AbsolutePath.make("/tmp/test"),
        title: "test",
        version: "test",
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
  })

const armInput = (sessionID: string, overrides: Partial<Parameters<typeof SessionSleep.arm>[1]> = {}) => ({
  id: SessionSleep.ID.ascending(),
  sessionID: SessionSchema.ID.make(sessionID),
  condition: "exit 1",
  description: "waiting for something",
  intervalMs: 60_000,
  checkTimeoutMs: 30_000,
  deadline: Date.now() + 3_600_000,
  cwd: "/tmp/test",
  nextCheckAt: Date.now(),
  ...overrides,
})

// One sqlite worker pair is built per test, which can take a few seconds on
// Windows; give the tests a generous timeout.
const TEST_TIMEOUT = 30_000

const withDb = (body: (db: Database.Interface["db"]) => Effect.Effect<void>) => async () => {
  await using tmp = await tmpdir()
  const filename = `${tmp.path}/test.sqlite`
  // layerFromPath applies pending migrations while building.
  await Effect.gen(function* () {
    const database = yield* Database.Service
    yield* body(database.db)
  }).pipe(Effect.provide(Database.layerFromPath(filename)), Effect.scoped, Effect.runPromise)
}

const itDb = (name: string, body: (db: Database.Interface["db"]) => Effect.Effect<void>) =>
  test(name, withDb(body), TEST_TIMEOUT)

describe("SessionSleep", () => {
  itDb(
    "arm inserts a pending trigger and replaces an existing pending one",
    (db) =>
      Effect.gen(function* () {
        yield* insertSession(db, "ses_a")
        const first = yield* SessionSleep.arm(db, armInput("ses_a"))
        expect(first.status).toBe("pending")

        const second = yield* SessionSleep.arm(db, armInput("ses_a"))
        expect(second.id).not.toBe(first.id)

        const fetched = yield* SessionSleep.get(db, SessionSchema.ID.make("ses_a"))
        expect(fetched?.id).toBe(second.id)

        const refreshedFirst = yield* SessionSleep.byID(db, first.id)
        expect(refreshedFirst?.status).toBe("cancelled")
      }),
  )

  itDb(
    "cancel disarms only the pending row",
    (db) =>
      Effect.gen(function* () {
        yield* insertSession(db, "ses_a")
        expect(yield* SessionSleep.cancel(db, SessionSchema.ID.make("ses_a"))).toBe(false)
        yield* SessionSleep.arm(db, armInput("ses_a"))
        expect(yield* SessionSleep.cancel(db, SessionSchema.ID.make("ses_a"))).toBe(true)
        expect(yield* SessionSleep.cancel(db, SessionSchema.ID.make("ses_a"))).toBe(false)
      }),
  )

  itDb(
    "claimCheck arbitrates and advances the schedule by the interval",
    (db) =>
      Effect.gen(function* () {
        yield* insertSession(db, "ses_a")
        const trigger = yield* SessionSleep.arm(db, armInput("ses_a", { intervalMs: 500 }))

        const due = yield* SessionSleep.due(db, Date.now() + 1)
        expect(due.map((row) => row.id)).toContain(trigger.id)

        expect(yield* SessionSleep.claimCheck(db, trigger.id, Date.now())).toBe(true)
        const claimed = yield* SessionSleep.byID(db, trigger.id)
        expect(claimed && claimed.nextCheckAt > Date.now() + 300).toBe(true)

        // Second claim before the interval elapses loses the race.
        expect(yield* SessionSleep.claimCheck(db, trigger.id, Date.now())).toBe(false)
      }),
  )

  itDb(
    "finish claims exactly once and feeds the deliverable queue",
    (db) =>
      Effect.gen(function* () {
        yield* insertSession(db, "ses_a")
        const trigger = yield* SessionSleep.arm(db, armInput("ses_a"))

        const won = yield* SessionSleep.finish(
          db,
          trigger.id,
          "fired",
          MessageID.make(`msg_sleep_${trigger.id}`),
          "payload",
        )
        expect(won).toBe(true)
        const lost = yield* SessionSleep.finish(db, trigger.id, "timed_out", MessageID.make(`msg_other_${trigger.id}`))
        expect(lost).toBe(false)

        const finished = yield* SessionSleep.byID(db, trigger.id)
        expect(finished?.status).toBe("fired")
        expect(finished?.messageID).toBe(`msg_sleep_${trigger.id}`)
        expect(finished?.lastOutput).toBe("payload")

        const deliverable = yield* SessionSleep.deliverable(db)
        expect(deliverable.map((row) => row.id)).toContain(trigger.id)

        expect(yield* SessionSleep.claimDelivery(db, trigger.id)).toBe(1)
        expect(yield* SessionSleep.claimDelivery(db, trigger.id)).toBeUndefined()

        yield* SessionSleep.releaseDelivery(db, trigger.id)
        const retried = yield* SessionSleep.deliverable(db)
        expect(retried.map((row) => row.id)).toContain(trigger.id)

        yield* SessionSleep.confirmDelivery(db, trigger.id)
        const done = yield* SessionSleep.deliverable(db)
        expect(done.map((row) => row.id)).not.toContain(trigger.id)
      }),
  )

  itDb(
    "recordFailure counts consecutive failures and recordNotMet resets them",
    (db) =>
      Effect.gen(function* () {
        yield* insertSession(db, "ses_a")
        const trigger = yield* SessionSleep.arm(db, armInput("ses_a"))

        expect(yield* SessionSleep.recordFailure(db, trigger.id, "boom")).toBe(1)
        expect(yield* SessionSleep.recordFailure(db, trigger.id, "boom")).toBe(2)
        yield* SessionSleep.recordNotMet(db, trigger.id, "fine")
        const after = yield* SessionSleep.byID(db, trigger.id)
        expect(after?.consecutiveFailures).toBe(0)
        expect(after?.lastOutput).toBe("fine")
      }),
  )

  itDb(
    "deliverable gives up after the retry budget",
    (db) =>
      Effect.gen(function* () {
        yield* insertSession(db, "ses_a")
        const trigger = yield* SessionSleep.arm(db, armInput("ses_a"))
        yield* SessionSleep.finish(db, trigger.id, "timed_out", MessageID.make(`msg_sleep_${trigger.id}`))

        for (let i = 0; i < SessionSleep.MAX_DELIVER_ATTEMPTS + 1; i++) {
          const claimed = yield* SessionSleep.claimDelivery(db, trigger.id)
          if (claimed === undefined) break
          yield* SessionSleep.releaseDelivery(db, trigger.id)
        }

        const deliverable = yield* SessionSleep.deliverable(db)
        expect(deliverable.map((row) => row.id)).not.toContain(trigger.id)
        const row = yield* SessionSleep.byID(db, trigger.id)
        expect(row?.deliverAttempts).toBe(SessionSleep.MAX_DELIVER_ATTEMPTS + 1)
      }),
  )

  itDb(
    "deleting the session cascades its triggers away",
    (db) =>
      Effect.gen(function* () {
        yield* insertSession(db, "ses_a")
        yield* SessionSleep.arm(db, armInput("ses_a"))
        yield* db
          .delete(SessionTable)
          .where(eq(SessionTable.id, SessionSchema.ID.make("ses_a")))
          .run()
          .pipe(Effect.orDie)
        const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
        expect(rows).toHaveLength(0)
      }),
  )
})
