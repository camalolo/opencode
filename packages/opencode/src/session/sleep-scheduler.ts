export * as SessionSleepScheduler from "./sleep-scheduler"

import { ChildProcess } from "effect/unstable/process"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Database, Database as DatabaseNode } from "@opencode-ai/core/database/database"
import { AppProcess } from "@opencode-ai/core/process"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionSleep } from "@opencode-ai/core/session/sleep"
import { MessageID as CoreMessageID } from "@opencode-ai/core/v1/session"

/** How often the scheduler scans for due checks. */
const TICK = "5 seconds"

/** Consecutive failed checks before the trigger disarms itself and reports. */
export const MAX_CONSECUTIVE_FAILURES = 5

const MAX_CAPTURE_BYTES = 64 * 1024
const PROBE_TIMEOUT_MS = 30_000

const defaultShell = () => (process.platform === "win32" ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh")

const isTimeout = (error: AppProcess.AppProcessError) =>
  error.cause instanceof Error && error.cause.message === "Timed out"

export interface CheckResult {
  readonly exitCode?: number
  readonly output: string
  readonly timedOut: boolean
}

export interface ArmInput {
  readonly sessionID: SessionSchema.ID
  readonly condition: string
  readonly description: string
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly checkTimeoutMs: number
  readonly cwd: string
  readonly shell?: string
}

export interface Interface {
  /** Replaces any armed trigger for the session with this one. */
  readonly arm: (input: ArmInput) => Effect.Effect<SessionSleep.Trigger>
  /** Cancels the session's armed trigger; false when nothing was armed. */
  readonly cancel: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Latest trigger for a session, regardless of status. */
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSleep.Trigger | undefined>
  /** Runs one condition check without arming anything. Used for the arm-time probe. */
  readonly probe: (input: {
    readonly condition: string
    readonly cwd: string
    readonly shell?: string
  }) => Effect.Effect<CheckResult>
  /** Drains all due checks now instead of waiting for the next tick. */
  readonly flush: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSleepScheduler") {}

const tail = (output: string, max: number) =>
  output.length <= max ? output : `…${output.slice(-max)}`

export const runCheck = Effect.fn("SessionSleepScheduler.runCheck")(function* (
  appProcess: AppProcess.Interface,
  input: {
    readonly condition: string
    readonly cwd: string
    readonly shell?: string
    readonly timeoutMs: number
  },
) {
  const command = ChildProcess.make(input.condition, [], {
    cwd: input.cwd,
    shell: input.shell ?? defaultShell(),
    stdin: "ignore",
    detached: process.platform !== "win32",
    forceKillAfter: Duration.seconds(3),
  })
  return yield* appProcess
    .run(command, {
      combineOutput: true,
      timeout: Duration.millis(input.timeoutMs),
      maxOutputBytes: MAX_CAPTURE_BYTES,
    })
    .pipe(
      Effect.map((result) => ({
        exitCode: result.exitCode,
        output: result.output?.toString("utf8") ?? "",
        timedOut: false,
      })),
      Effect.catchTag("AppProcessError", (error) =>
        Effect.succeed({
          exitCode: undefined,
          output: isTimeout(error) ? "check timed out" : String(error.cause ?? error),
          timedOut: isTimeout(error),
        }),
      ),
    )
})

/**
 * Global trigger scheduler. Owns the poll loop that turns armed
 * `session_sleep` rows into terminal rows (fired / timed_out / failed); the
 * companion SessionSleepDelivery service observes those terminal rows and
 * wakes the sessions. Deliberately knows nothing about prompts or instances
 * so that the tool registry can depend on it without a dependency cycle.
 *
 * Every mutation is a row-level claim in sqlite, which is what makes several
 * concurrent schedulers safe (duplicated layer copies, TUI plus server
 * processes) rather than any single-instance assumption.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const store = yield* SessionStore.Service
    const appProcess = yield* AppProcess.Service

    const probe: Interface["probe"] = (input) => runCheck(appProcess, { ...input, timeoutMs: PROBE_TIMEOUT_MS })

    const processRow = Effect.fn("SessionSleepScheduler.processRow")(function* (row: SessionSleep.Trigger) {
      const now = Date.now()
      if (now >= row.deadline) {
        yield* SessionSleep.finish(db, row.id, "timed_out", wakeMessageID(row))
        return
      }
      if (!(yield* SessionSleep.claimCheck(db, row.id, now))) return
      const result = yield* runCheck(appProcess, {
        condition: row.condition,
        cwd: row.cwd,
        ...(row.shell === undefined ? {} : { shell: row.shell }),
        timeoutMs: row.checkTimeoutMs,
      })
      if (result.exitCode === 0) {
        yield* SessionSleep.finish(db, row.id, "fired", wakeMessageID(row), tail(result.output, 4096))
        yield* Effect.logInfo("sleep trigger fired", { "session.id": row.sessionID, trigger: row.id })
        return
      }
      if (result.exitCode === 1) {
        yield* SessionSleep.recordNotMet(db, row.id, tail(result.output, 4096))
        return
      }
      const failures = yield* SessionSleep.recordFailure(db, row.id, tail(result.output, 4096))
      if (failures !== undefined && failures >= MAX_CONSECUTIVE_FAILURES) {
        yield* SessionSleep.finish(db, row.id, "failed", wakeMessageID(row))
        yield* Effect.logWarning("sleep trigger disarmed after repeated check failures", {
          "session.id": row.sessionID,
          trigger: row.id,
          failures,
        })
      }
    })

    const tick = Effect.fn("SessionSleepScheduler.tick")(function* () {
      const due = yield* SessionSleep.due(db, Date.now())
      yield* Effect.forEach(due, (row) => processRow(row).pipe(Effect.ignore), { concurrency: 4, discard: true })
    })

    yield* Effect.forkScoped(
      tick().pipe(
        Effect.delay(Duration.seconds(3)),
        Effect.repeat(Schedule.spaced(TICK)),
        Effect.catchCause((cause) => Effect.logError("sleep scheduler tick failed", { cause })),
        Effect.ignore,
      ),
    )

    return Service.of({
      arm: (input) =>
        SessionSleep.arm(db, {
          id: SessionSleep.ID.ascending(),
          sessionID: input.sessionID,
          condition: input.condition,
          description: input.description,
          intervalMs: input.intervalMs,
          checkTimeoutMs: input.checkTimeoutMs,
          deadline: Date.now() + input.timeoutMs,
          cwd: input.cwd,
          ...(input.shell === undefined ? {} : { shell: input.shell }),
          nextCheckAt: Date.now(),
        }),
      cancel: (sessionID) => SessionSleep.cancel(db, sessionID),
      get: (sessionID) => SessionSleep.get(db, sessionID),
      probe,
      flush: tick,
    })
  }),
)

export { layer }

/** Deterministic wake message id per trigger, so redelivery cannot duplicate prompts. */
function wakeMessageID(row: SessionSleep.Trigger) {
  return CoreMessageID.make(`msg_sleep_${row.id}`)
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [DatabaseNode.node, SessionStore.node, AppProcess.node],
})
