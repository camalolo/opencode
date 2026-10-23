export * as SupervisedLoop from "./supervised"

import { Effect, Exit, Fiber } from "effect"

const RESTART_DELAY_MILLIS = 1_000

/**
 * Runs a background loop fiber under supervision: if the loop ever exits —
 * defect, interruption from a lost scope, schedule exhaustion, anything — the
 * exit is logged and the loop is restarted after a short delay, forever.
 *
 * `Effect.repeat` loops stop at their first uncaught failure and
 * `Effect.forkScoped` fibers die silently with their scope; either failure
 * mode used to leave background work (sleep triggers, wake delivery) pending
 * forever with nothing but an in-memory heartbeat to notice. This wrapper is
 * the liveness backstop: the only way the loop stops is shutdown, because the
 * supervisor itself is forked into the layer's scope.
 */
export const supervise = Effect.fn("SupervisedLoop.supervise")(function* (
  name: string,
  loop: Effect.Effect<void>,
) {
  yield* Effect.logInfo(`${name}: loop started`)
  while (true) {
    const fiber = yield* Effect.forkScoped(loop)
    const exit = yield* Fiber.await(fiber)
    if (Exit.isFailure(exit)) {
      yield* Effect.logError(`${name}: loop exited unexpectedly; restarting in ${RESTART_DELAY_MILLIS}ms`, {
        cause: String(exit.cause),
      })
    } else {
      yield* Effect.logWarning(`${name}: loop exited cleanly; restarting in ${RESTART_DELAY_MILLIS}ms`)
    }
    yield* Effect.sleep(`${RESTART_DELAY_MILLIS} millis`)
  }
})
