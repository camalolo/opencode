export * as SessionSleepDelivery from "./sleep-delivery"

import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { Database, Database as DatabaseNode } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionSleep, MAX_DELIVER_ATTEMPTS as MAX_WAKE_ATTEMPTS } from "@opencode-ai/core/session/sleep"
import { InstanceStore } from "@/project/instance-store"
import { SessionPrompt } from "./prompt"
import { SessionStatus } from "./status"

/** How often undelivered wakes are rescanned; also the repair cadence after crashes. */
const TICK = "5 seconds"

/** Consecutive failed checks before the trigger disarms itself and reports. */
export const MAX_CONSECUTIVE_FAILURES = 5

const MAX_WAKE_OUTPUT_CHARS = 4 * 1024

const tail = (output: string) =>
  output.length <= MAX_WAKE_OUTPUT_CHARS ? output : `…${output.slice(-MAX_WAKE_OUTPUT_CHARS)}`

export const wakeText = (row: SessionSleep.Trigger, output: string) => {
  const detail = output.trim().length > 0 ? `\n\nLast check output:\n${tail(output)}` : ""
  if (row.status === "fired")
    return [
      `⏰ Sleep trigger fired: ${row.description}`,
      "",
      "The condition check you armed with the sleep_until tool exited 0." + detail,
      "",
      "The trigger is disarmed. Continue working on this now.",
    ].join("\n")
  if (row.status === "timed_out")
    return [
      `⏰ Sleep trigger timed out: ${row.description}`,
      "",
      "The condition never became true within the timeout." + detail,
      "",
      "The trigger is disarmed. Re-arm it, adjust the condition, or move on.",
    ].join("\n")
  return [
    `⏰ Sleep trigger failed: ${row.description}`,
    "",
    `The condition check kept failing (non-zero exit or timeout) ${MAX_CONSECUTIVE_FAILURES} times in a row, so the trigger disarmed itself instead of spinning forever.` +
      detail,
    "",
    "Inspect the condition, fix it, and re-arm with sleep_until if needed.",
  ].join("\n")
}

export interface Interface {
  /** Delivers any pending wake rows now. Exposed for tests and immediate delivery. */
  readonly flush: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSleepDelivery") {}

/**
 * Global wake-delivery service. Watches terminal `session_sleep` rows and
 * admits their wake message through the normal user-prompt entry (the same
 * path as the prompt HTTP endpoint), booting the session's instance on
 * demand — so a wake lands even when no client is connected. Delivery claims
 * are row-level, making multiple concurrent instances of this service safe.
 */
const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const store = yield* SessionStore.Service
    const instances = yield* InstanceStore.Service
    const prompt = yield* SessionPrompt.Service
    const status = yield* SessionStatus.Service

    const deliver = Effect.fn("SessionSleepDelivery.deliver")(function* (row: SessionSleep.Trigger) {
      const attempts = yield* SessionSleep.claimDelivery(db, row.id)
      if (attempts === undefined) return
      const session = yield* store.get(row.sessionID)
      if (!session) {
        yield* SessionSleep.confirmDelivery(db, row.id)
        return
      }
      const text = wakeText(row, row.lastOutput ?? "")
      const outcome = yield* instances
        .provide(
          { directory: session.location.directory },
          prompt.prompt({ sessionID: row.sessionID, parts: [{ type: "text", text }] }).pipe(
            Effect.as(true),
            Effect.catch((error) => Effect.succeed(error)),
          ),
        )
      if (outcome === true) {
        yield* SessionSleep.confirmDelivery(db, row.id)
        yield* Effect.logInfo("sleep trigger delivered", {
          "session.id": row.sessionID,
          trigger: row.id,
          status: row.status,
        })
        return
      }
      // The prompt failed; clear the stale sleeping badge so the wake can retry.
      yield* instances
        .provide({ directory: session.location.directory }, status.set(row.sessionID, { type: "idle" }))
        .pipe(Effect.ignore)
      if (attempts >= MAX_WAKE_ATTEMPTS) {
        yield* SessionSleep.confirmDelivery(db, row.id)
        yield* Effect.logError("sleep trigger delivery abandoned", {
          "session.id": row.sessionID,
          trigger: row.id,
          attempts,
          cause: String(outcome),
        })
        return
      }
      yield* SessionSleep.releaseDelivery(db, row.id)
      yield* Effect.logError("sleep trigger delivery failed", {
        "session.id": row.sessionID,
        trigger: row.id,
        attempts,
        cause: String(outcome),
      })
    })

    const flush: Interface["flush"] = Effect.fn("SessionSleepDelivery.flush")(function* () {
      const undelivered = yield* SessionSleep.deliverable(db)
      yield* Effect.forEach(undelivered, (row) => deliver(row).pipe(Effect.ignore), { concurrency: 3, discard: true })
    })

    yield* Effect.forkScoped(
      flush().pipe(
        Effect.delay(Duration.seconds(3)),
        Effect.repeat(Schedule.spaced(TICK)),
        Effect.catchCause((cause) => Effect.logError("sleep delivery tick failed", { cause })),
        Effect.ignore,
      ),
    )

    return Service.of({ flush })
  }),
)

export { layer }

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [DatabaseNode.node, SessionStore.node, InstanceStore.node, SessionPrompt.node, SessionStatus.node],
})
