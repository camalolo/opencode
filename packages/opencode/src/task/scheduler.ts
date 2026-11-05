export * as TaskScheduler from "./scheduler"

import { Cause, Context, Duration, Effect, Layer, Schedule } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Idle } from "@opencode-ai/core/idle"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionExecutionLocal } from "@opencode-ai/core/session/execution/local"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ScheduledTask } from "@opencode-ai/core/task/task"
import { Task } from "@opencode-ai/schema/task"
import { SupervisedLoop } from "@/effect/supervised"

/** How often the scheduler scans for due tasks and pending runs. */
const TICK = "10 seconds"

/** Delivery concurrency cap: running sessions are expensive. */
const DELIVERY_CONCURRENCY = 4

/** Run-history pruning cadence. */
const PRUNE_EVERY_MS = 60 * 60 * 1000

const errorText = (cause: Cause.Cause<unknown>) => {
  const squashed = Cause.squash(cause)
  return squashed instanceof Error ? squashed.message : String(squashed)
}

const sessionTitle = (task: ScheduledTask.Info, run: ScheduledTask.Run) =>
  `${task.name} - ${new Date(run.scheduledAt).toISOString()}`

export interface Interface {
  /** Drains due tasks and pending runs now instead of waiting for the next tick. */
  readonly flush: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskScheduler") {}

/**
 * Global scheduler for durable scheduled tasks. Every mutation is a row-level
 * claim in sqlite (`session_sleep` convention), so several concurrent
 * schedulers are safe: whichever process wins a slot or a pending run delivers
 * it, and the others skip. Delivery creates a fresh session per run, admits the
 * prompt without waking, then owns the drain itself — the drain fiber's exit is
 * the run's completion verdict, which needs no idle-status event.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const session = yield* SessionV2.Service
    const execution = yield* SessionExecution.Service

    const publish = Effect.fn("TaskScheduler.publish")(function* (task: ScheduledTask.Info, run: ScheduledTask.Run) {
      yield* events.publish(Task.Event.RunUpdated, { run }, { location: { directory: task.directory } }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("task run event publish failed", { cause, run: run.id })),
      )
    })

    const finalize = Effect.fn("TaskScheduler.finalize")(function* (
      task: ScheduledTask.Info,
      run: ScheduledTask.Run,
      status: Exclude<Task.RunStatus, "pending" | "running">,
      error?: string,
    ) {
      const finished = yield* ScheduledTask.finishRun(db, run.id, status, error)
      if (!finished) return
      yield* publish(task, finished)
    })

    /** One run: create session, admit prompt, await the drain. */
    const runTask = Effect.fn("TaskScheduler.runTask")(function* (task: ScheduledTask.Info, run: ScheduledTask.Run) {
      const info = yield* session.create({
        ...(task.agent === undefined ? {} : { agent: task.agent }),
        ...(task.model === undefined ? {} : { model: task.model }),
        title: sessionTitle(task, run),
        location: { directory: task.directory },
      })
      yield* ScheduledTask.attachSession(db, run.id, info.id)
      yield* session.prompt({
        sessionID: info.id,
        id: SessionMessage.ID.make(`msg_task_${run.id}`),
        prompt: { text: task.prompt },
        delivery: "queue",
        resume: false,
      })
      // Own the drain: its exit is the run verdict, and an operator interrupt
      // (or the timeout watchdog) interrupts this fiber through the session.
      yield* execution.resume(info.id)
    })

    const deliver = Effect.fn("TaskScheduler.deliver")(function* (task: ScheduledTask.Info, run: ScheduledTask.Run) {
      if (!(yield* ScheduledTask.startRun(db, run.id))) return
      yield* publish(task, { ...run, status: "running", timeStarted: Date.now() })
      const outcome = yield* runTask(task, run).pipe(
        Effect.matchCauseEffect({
          onSuccess: () =>
            Effect.succeed<{ status: "completed" | "cancelled" | "failed"; error?: string }>({
              status: "completed",
            }),
          onFailure: (cause) =>
            Effect.succeed(
              Cause.hasInterruptsOnly(cause)
                ? { status: "cancelled" as const }
                : { status: "failed" as const, error: errorText(cause) },
            ),
        }),
      )
      yield* finalize(task, run, outcome.status, outcome.error)
    })

    let lastPruneAt = 0

    const tick = Effect.fn("TaskScheduler.tick")(function* () {
      const now = Date.now()

      const claimed = yield* ScheduledTask.claimDue(db, now)
      for (const entry of claimed) yield* publish(entry.task, entry.run)

      // Pending rows include this tick's claims, manual triggers, and runs
      // whose earlier delivery attempt failed before claiming.
      const pending = yield* ScheduledTask.pendingRuns(db)
      yield* Effect.forEach(
        pending,
        (entry) =>
          deliver(entry.task, entry.run).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("task delivery failed", { cause, run: entry.run.id, task: entry.task.id }),
            ),
          ),
        { concurrency: DELIVERY_CONCURRENCY, discard: true },
      )

      // Timeout watchdog: terminal verdict first (the delivery fiber cannot
      // overwrite it), then interrupt the drain that is still running.
      const overdue = yield* ScheduledTask.overdueRuns(db, Date.now())
      for (const entry of overdue) {
        const timeout = entry.task.runTimeoutMs
        yield* finalize(
          entry.task,
          entry.run,
          "failed",
          timeout === undefined ? "run timed out" : `run exceeded its ${timeout}ms timeout`,
        )
        if (entry.run.sessionID !== undefined) yield* execution.interrupt(entry.run.sessionID)
      }

      // Claims, pending runs, and overdue runs keep the fast tick even while
      // idle; scheduled future runs may stretch by one idle pace.
      yield* Idle.backgroundDelay(TICK, () => claimed.length + pending.length + overdue.length > 0)

      if (now - lastPruneAt >= PRUNE_EVERY_MS) {
        lastPruneAt = now
        const tasks = yield* ScheduledTask.all(db)
        for (const task of tasks) yield* ScheduledTask.pruneRuns(db, task.id, task.retainRuns ?? 20)
      }
    })

    // Runs owned by a dead process cannot finish on their own; fail them so
    // history stays truthful and the skip policy cannot wedge on a ghost.
    const abandoned = yield* ScheduledTask.failRunning(db, "interrupted: scheduler process exited before the run finished")
    if (abandoned.length > 0)
      yield* Effect.logWarning("failed scheduled task runs left by a previous process", {
        runs: abandoned.length,
      })

    yield* Effect.forkScoped(
      SupervisedLoop.supervise(
        "task scheduler",
        tick().pipe(
          Effect.catchCause((cause) => Effect.logError("task scheduler tick failed", { cause })),
          Effect.delay(Duration.seconds(3)),
          Effect.repeat(Schedule.spaced(TICK)),
          Effect.ignore,
        ),
      ),
    )

    return Service.of({ flush: tick })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node, SessionV2.node, SessionExecutionLocal.node],
})
