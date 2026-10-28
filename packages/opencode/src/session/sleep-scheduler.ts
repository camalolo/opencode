export * as SessionSleepScheduler from "./sleep-scheduler"

import { ChildProcess } from "effect/unstable/process"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Database, Database as DatabaseNode } from "@opencode-ai/core/database/database"
import { AppProcess } from "@opencode-ai/core/process"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { MAX_BROKEN_CHECKS, SessionSleep } from "@opencode-ai/core/session/sleep"
import { SupervisedLoop } from "@/effect/supervised"
import { SessionStatus } from "./status"

/** How often the scheduler scans for due checks. */
const TICK = "5 seconds"

/** How often the watchdog verifies the loop is still making progress. */
const WATCHDOG = "30 seconds"

/**
 * Watchdog stall threshold. Must exceed both several tick periods and a
 * plausible in-flight check (check timeout defaults to 30s), so a legitimately
 * slow check batch is not mistaken for a wedged loop. A false positive is
 * harmless anyway — the forced drain is claim-safe.
 */
const STALL_AFTER_MS = 60_000

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

/** One evaluated check: the verdict plus the output worth showing the session. */
export interface CheckOutcome {
  readonly verdict: CheckVerdict
  readonly output: string
}

/**
 * cmd.exe and PowerShell both report a missing command with "is not recognized"
 * (and cmd collapses the error to exit code 1, indistinguishable from "not met"
 * by exit code alone); POSIX shells print "command not found" and exit 127.
 */
const COMMAND_NOT_FOUND_PATTERNS = ["is not recognized", "command not found"]

export type CheckVerdict =
  | { readonly kind: "met" }
  | { readonly kind: "unmet" }
  | { readonly kind: "broken"; readonly reason: string }

/**
 * Interprets one check result against the sleep_until contract (exit 0 = met,
 * exit 1 = not met, anything else = broken). An unmet check must also prove it
 * is alive by producing output: a silent exit 1 is indistinguishable from a
 * dead or mis-suppressed check, so it counts as broken — which the arm-time
 * probe gate turns into a refusal to arm. Shared by the probe gate and the
 * background loop so both agree on what "broken" means.
 */
export const classifyCheck = (result: CheckResult): CheckVerdict => {
  if (result.timedOut) return { kind: "broken", reason: "the check timed out" }
  if (result.exitCode === undefined)
    return { kind: "broken", reason: result.output.trim() || "the check failed to run" }
  if (result.exitCode === 0) return { kind: "met" }
  if (result.exitCode === 127) return { kind: "broken", reason: "command not found (exit code 127)" }
  if (COMMAND_NOT_FOUND_PATTERNS.some((pattern) => result.output.includes(pattern)))
    return { kind: "broken", reason: `command not found (the shell reported it, exit code ${result.exitCode})` }
  if (result.exitCode === 1) {
    if (result.output.trim().length === 0)
      return {
        kind: "broken",
        reason:
          'silent check: exit 1 with no output. A healthy condition prints progress when unmet, e.g. append `|| echo "still waiting"` — a silent exit 1 is indistinguishable from a dead check.',
      }
    return { kind: "unmet" }
  }
  return { kind: "broken", reason: `exit code ${result.exitCode} (valid conditions exit 0 or 1)` }
}

/**
 * Judges the observe stage of a state check, whose exit code is meaningless —
 * it only prints the state document (e.g. `grep -q pattern file` legitimately
 * exits 1 when the pattern is absent). Broken therefore means "produced no
 * state at all": timeout, spawn failure, or a missing command. Returns the
 * problem, or undefined when the observe ran fine.
 */
export const observeProblem = (result: CheckResult): string | undefined => {
  if (result.timedOut) return "the observe timed out"
  if (result.exitCode === undefined) return result.output.trim() || "the observe failed to run"
  if (result.exitCode === 127) return "command not found (exit code 127)"
  if (COMMAND_NOT_FOUND_PATTERNS.some((pattern) => result.output.includes(pattern)))
    return `command not found (the shell reported it, exit code ${result.exitCode})`
  return undefined
}

export interface ArmInput {
  readonly sessionID: SessionSchema.ID
  readonly description: string
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly checkTimeoutMs: number
  readonly cwd: string
  readonly shell?: string
  /** Legacy single-string condition; omit when arming a state check. */
  readonly condition?: string
  /** State check: observe prints the state, predicate judges it, metExample was proven to satisfy the predicate at arm time. */
  readonly observe?: string
  readonly predicate?: string
  readonly metExample?: string
}

export interface Interface {
  /** Replaces any armed trigger for the session with this one. */
  readonly arm: (input: ArmInput) => Effect.Effect<SessionSleep.Trigger>
  /** Cancels the session's armed trigger; false when nothing was armed. */
  readonly cancel: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Latest trigger for a session, regardless of status. */
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSleep.Trigger | undefined>
  /** Runs one condition check without arming anything. Used for the arm-time proof gate. */
  readonly probe: (input: {
    readonly condition: string
    readonly cwd: string
    readonly shell?: string
    readonly timeoutMs?: number
    readonly stdin?: string
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
    /** Text piped into the check's stdin (state documents, met examples). */
    readonly stdin?: string
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
      ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
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
 * Evaluates a state trigger: observe prints the current state document, then
 * the predicate judges it on stdin. The two stages split the check budget.
 * The combined output pairs the predicate's progress line with the state
 * document, so `sleep_status` and the wake message carry the actual state.
 */
export const runStateCheck = Effect.fn("SessionSleepScheduler.runStateCheck")(function* (
  appProcess: AppProcess.Interface,
  input: {
    readonly observe: string
    readonly predicate: string
    readonly cwd: string
    readonly shell?: string
    readonly timeoutMs: number
  },
) {
  const budget = Math.max(Math.floor(input.timeoutMs / 2), 5_000)
  const options = {
    cwd: input.cwd,
    ...(input.shell === undefined ? {} : { shell: input.shell }),
  }
  const observed = yield* runCheck(appProcess, { condition: input.observe, ...options, timeoutMs: budget })
  const problem = observeProblem(observed)
  if (problem !== undefined)
    return { verdict: { kind: "broken" as const, reason: problem }, output: observed.output }
  const judged = yield* runCheck(appProcess, {
    condition: input.predicate,
    ...options,
    timeoutMs: budget,
    stdin: observed.output,
  })
  const verdict = classifyCheck(judged)
  const progress = judged.output.trim()
  const state = observed.output.trim()
  return {
    verdict,
    output: [progress.length > 0 ? progress : undefined, state.length > 0 ? `[state]\n${state}` : undefined]
      .filter(Boolean)
      .join("\n\n"),
  }
})

/**
 * Global trigger scheduler. Owns the poll loop that turns armed
 * `session_sleep` rows into terminal rows (fired / timed_out / failed); the
 * companion SessionSleepDelivery service observes those terminal rows and
 * wakes the sessions. A watchdog fiber forces a drain whenever the loop stops
 * making progress, so a wedged tick cannot leave armed triggers in limbo.
 * Deliberately knows nothing about prompts or instances
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

    const probe: Interface["probe"] = (input) =>
      runCheck(appProcess, { ...input, timeoutMs: input.timeoutMs ?? PROBE_TIMEOUT_MS })

    /**
     * Watchdog heartbeat: refreshed whenever the loop scans, claims, or
     * finishes work. If it goes stale past STALL_AFTER_MS, the loop is wedged
     * or dead and the watchdog forces a claim-safe drain from this process.
     */
    let lastProgressAt = Date.now()

    const processRow = Effect.fn("SessionSleepScheduler.processRow")(function* (row: SessionSleep.Trigger) {
      lastProgressAt = Date.now()
      const now = Date.now()
      const lateMs = now - row.nextCheckAt
      if (lateMs > Math.max(row.intervalMs * 3, 120_000))
        yield* Effect.logWarning("sleep check claimed late; the scheduler loop is being starved", {
          "session.id": row.sessionID,
          trigger: row.id,
          late_ms: lateMs,
          interval_ms: row.intervalMs,
        })
      if (now >= row.deadline) {
        yield* SessionSleep.finish(db, row.id, "timed_out", SessionSleep.wakeMessageID(row))
        return
      }
      if (!(yield* SessionSleep.claimCheck(db, row.id, now))) return
      const outcome = SessionSleep.isStateTrigger(row)
        ? yield* runStateCheck(appProcess, {
            observe: row.observe,
            predicate: row.predicate,
            cwd: row.cwd,
            ...(row.shell === undefined ? {} : { shell: row.shell }),
            timeoutMs: row.checkTimeoutMs,
          })
        : yield* runCheck(appProcess, {
            condition: row.condition,
            cwd: row.cwd,
            ...(row.shell === undefined ? {} : { shell: row.shell }),
            timeoutMs: row.checkTimeoutMs,
          }).pipe(Effect.map((result) => ({ verdict: classifyCheck(result), output: result.output })))
      lastProgressAt = Date.now()
      const verdict = outcome.verdict
      if (verdict.kind === "met") {
        yield* SessionSleep.finish(db, row.id, "fired", SessionSleep.wakeMessageID(row), tail(outcome.output, 4096))
        yield* Effect.logInfo("sleep trigger fired", { "session.id": row.sessionID, trigger: row.id })
        return
      }
      if (verdict.kind === "unmet") {
        yield* SessionSleep.recordNotMet(db, row.id, tail(outcome.output, 4096))
        return
      }
      const failures = yield* SessionSleep.recordFailure(db, row.id, tail(outcome.output, 4096))
      if (failures !== undefined && failures >= MAX_BROKEN_CHECKS) {
        yield* SessionSleep.finish(db, row.id, "failed", SessionSleep.wakeMessageID(row))
        yield* Effect.logWarning("sleep trigger disarmed after broken checks", {
          "session.id": row.sessionID,
          trigger: row.id,
          failures,
          reason: verdict.reason,
        })
      }
    })

    const tick = Effect.fn("SessionSleepScheduler.tick")(function* () {
      // Deadline authority lives here even though processRow also checks it:
      // a row whose claim was taken by a hung check never becomes due again,
      // and this sweep is what guarantees a pending trigger can outlive its
      // timeout by at most one tick.
      yield* SessionSleep.sweepOverdue(db, Date.now()).pipe(
        Effect.catchCause((cause) => Effect.logWarning("sleep deadline sweep failed", { cause })),
      )
      const due = yield* SessionSleep.due(db, Date.now())
      lastProgressAt = Date.now()
      // Each row is caught on its own so one defecting row cannot take the
      // whole batch (and with it the loop's progress heartbeat) down.
      yield* Effect.forEach(
        due,
        (row) =>
          processRow(row).pipe(
            Effect.catchCause((cause) => Effect.logWarning("sleep check failed", { cause, row: row.id })),
          ),
        { concurrency: 4, discard: true },
      )
    })

    const watchdog = Effect.fn("SessionSleepScheduler.watchdog")(function* () {
      const idleMs = Date.now() - lastProgressAt
      if (idleMs < STALL_AFTER_MS) return
      yield* Effect.logWarning("sleep scheduler made no progress; forcing a drain", { idleMs })
      yield* tick()
    })

    // Both loops run under supervision: `Effect.repeat` stops at its first
    // uncaught failure and a forked fiber dies silently with its scope, and
    // either death used to strand armed triggers in limbo with no timeout
    // escape (observed in production). The supervisor restarts them forever;
    // shutdown interrupts the supervisor itself.
    yield* Effect.forkScoped(
      SupervisedLoop.supervise(
        "sleep scheduler",
        tick().pipe(
          Effect.catchCause((cause) => Effect.logError("sleep scheduler tick failed", { cause })),
          Effect.delay(Duration.seconds(3)),
          Effect.repeat(Schedule.spaced(TICK)),
          Effect.ignore,
        ),
      ),
    )
    yield* Effect.forkScoped(
      SupervisedLoop.supervise(
        "sleep scheduler watchdog",
        watchdog().pipe(
          Effect.catchCause((cause) => Effect.logError("sleep scheduler watchdog failed", { cause })),
          Effect.delay(Duration.seconds(30)),
          Effect.repeat(Schedule.spaced(WATCHDOG)),
          Effect.ignore,
        ),
      ),
    )

    return Service.of({
      arm: (input) =>
        SessionSleep.arm(db, {
          id: SessionSleep.ID.ascending(),
          sessionID: input.sessionID,
          ...(input.condition === undefined ? {} : { condition: input.condition }),
          ...(input.observe === undefined ? {} : { observe: input.observe }),
          ...(input.predicate === undefined ? {} : { predicate: input.predicate }),
          ...(input.metExample === undefined ? {} : { metExample: input.metExample }),
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

/**
 * The idle transition must not clobber an armed trigger: when a session stops
 * while a sleep_until trigger is pending, re-seed the sleeping status from the
 * durable row instead of going idle. Callers (run-state, processor) use this
 * wherever they would have published a plain idle status.
 */
export const settleIdle = Effect.fn("SessionSleepScheduler.settleIdle")(function* (
  scheduler: Interface,
  status: { set: (sessionID: SessionSchema.ID, status: SessionStatus.Info) => Effect.Effect<void> },
  sessionID: SessionSchema.ID,
) {
  const latest = yield* scheduler.get(sessionID)
  if (latest?.status === "pending") {
    yield* status.set(sessionID, {
      type: "sleeping",
      description: latest.description,
      wake_at: latest.deadline,
      next_check_at: latest.nextCheckAt,
      interval_ms: latest.intervalMs,
    })
    return
  }
  yield* status.set(sessionID, { type: "idle" })
})

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [DatabaseNode.node, SessionStore.node, AppProcess.node],
})
