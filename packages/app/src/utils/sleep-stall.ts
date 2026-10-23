import { Accessor, createSignal } from "solid-js"

export type SleepingStatus = {
  type: string
  wake_at?: number
  next_check_at?: number
  interval_ms?: number
}

/** How far past the due check time a trigger may lag before the heartbeat counts as stalled. */
const stallGraceMs = 60_000

/**
 * A sleeping session whose next background check is long past due is not
 * verifiably waiting anymore: the scheduler loop looks wedged and neither the
 * wake nor the timeout can be trusted. Callers surface this by deforming the
 * sleeping indicator instead of leaving "sleeping" indistinguishable from a
 * broken wait.
 */
export const isSleepStalled = (status: SleepingStatus | undefined, now: number) => {
  if (status?.type !== "sleeping" || status.next_check_at === undefined) return false
  const interval = status.interval_ms ?? 60_000
  return now > status.next_check_at + Math.max(interval * 2, stallGraceMs)
}

// One shared ticker keeps every sleeping indicator re-evaluating without each
// component running its own interval.
const [now, setNow] = createSignal(Date.now())
let tickerStarted = false

export const useNow = (intervalMs = 15_000): Accessor<number> => {
  if (!tickerStarted && typeof window !== "undefined") {
    tickerStarted = true
    setInterval(() => setNow(Date.now()), intervalMs)
  }
  return now
}
