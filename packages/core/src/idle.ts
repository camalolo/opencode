export * as Idle from "./idle"

import { Duration, Effect } from "effect"
import { Flag } from "./flag/flag"

/**
 * Process-global activity bookkeeping that paces background tick loops.
 *
 * Background loops (session search-index sync, sleep scheduler/delivery, task
 * scheduler) tick every 1-10 seconds forever. With no clients and no sessions
 * that is pure waste; the fleet used to mask it with an external cpulimit
 * service that SIGSTOPped the whole process and stalled every request's first
 * byte. This governor tracks real activity signals instead and lets those
 * loops stretch their cadence while idle. Only background pacing changes -
 * the request path never consults the governor, so request latency is
 * unaffected at all times.
 *
 * Signals:
 * - `mark()` - real client work happened (instance-route HTTP request, event
 *   publication, session drain). SSE heartbeats deliberately do not mark so a
 *   parked client can go quiet.
 * - client counting - open SSE event streams and websockets.
 * - drain counting - active session executions pin the fast pace.
 *
 * Two idle tiers: no clients at all for a short grace, or clients attached
 * but nothing happening for a long grace.
 */

const state = { clients: 0, drains: 0, lastActivity: Date.now() }

export const mark = () => {
  state.lastActivity = Date.now()
}

export const clientInc = () => {
  state.clients++
  mark()
}

export const clientDec = () => {
  state.clients = Math.max(0, state.clients - 1)
  mark()
}

export const drainInc = () => {
  state.drains++
  mark()
}

export const drainDec = () => {
  state.drains = Math.max(0, state.drains - 1)
  mark()
}

/** True when background loops may stretch their cadence. */
export const idle = () => {
  if (Flag.OPENCODE_IDLE_DISABLE) return false
  if (state.drains > 0) return false
  const quietFor = Date.now() - state.lastActivity
  const idleAfter = Flag.OPENCODE_IDLE_AFTER_MS ?? 120_000
  const quietAfter = Flag.OPENCODE_QUIET_AFTER_MS ?? 600_000
  return state.clients > 0 ? quietFor >= quietAfter : quietFor >= idleAfter
}

/**
 * Extra sleep for a background loop whose fast cadence is `fast` (its
 * normal-tick sleep stays in the loop). No-op unless the process is idle;
 * while idle it sleeps up to the pace duration minus `fast`, in slices,
 * returning early the moment activity resumes or the loop's own `skip`
 * predicate (pending work that needs the fast cadence, e.g. armed sleep
 * triggers) turns true.
 */
export const backgroundDelay = Effect.fn("Idle.backgroundDelay")(function* (
  fast: Duration.Input,
  skip?: () => boolean,
) {
  const pace = Flag.OPENCODE_IDLE_PACE_MS ?? 30_000
  const slice = Flag.OPENCODE_IDLE_SLICE_MS ?? 5_000
  let remaining = pace - Duration.toMillis(fast)
  if (Flag.OPENCODE_IDLE_DISABLE || remaining <= 0) return
  while (remaining > 0 && !skip?.() && idle()) {
    const step = Math.min(slice, remaining)
    yield* Effect.sleep(Duration.millis(step))
    remaining -= step
  }
})
