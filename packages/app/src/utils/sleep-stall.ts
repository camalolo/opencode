import { Accessor, createSignal } from "solid-js"

export type SleepingStatus = {
  type: string
  description?: string
  wake_at?: number
  next_check_at?: number
  interval_ms?: number
  loop_forever?: boolean
  broken_checks?: number
  broken_check_limit?: number
  check_kind?: string
}

export type SleepPhase = "normal" | "near" | "stalled"

/** Narrow a session status to its sleeping trigger, if there is one. */
export const sleepingStatus = (status: SleepingStatus | undefined) =>
  status?.type === "sleeping" ? status : undefined

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

/**
 * Watcher health for indicator colors: stalled beats near-deadline (a wedged
 * watcher is more alarming than one about to resolve), and the near threshold
 * scales with the check cadence so fast and slow watches warn at the same
 * number of remaining checks.
 */
export const sleepPhase = (status: SleepingStatus | undefined, now: number): SleepPhase => {
  if (status?.type !== "sleeping") return "normal"
  if (isSleepStalled(status, now)) return "stalled"
  const interval = status.interval_ms ?? 60_000
  if (status.wake_at !== undefined && status.wake_at - now <= Math.max(interval * 5, stallGraceMs)) return "near"
  return "normal"
}

/** Compact time left until the trigger times out: `45s`, `42m`, `2h05`. */
export const sleepCountdown = (wakeAt: number | undefined, now: number) => {
  if (wakeAt === undefined) return ""
  const left = wakeAt - now
  if (left <= 0) return "0s"
  if (left < 60_000) return `${Math.ceil(left / 1000)}s`
  const minutes = Math.ceil(left / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}`
}

type Translate = (key: string, params?: Record<string, string | number>) => string

/**
 * One-line native tooltip for the sleeping indicator. Composed of complete
 * i18n sentences; loop and broken-check facts only appear when armed.
 */
export const sleepTooltip = (status: SleepingStatus, now: number, t: Translate): string => {
  const phase = sleepPhase(status, now)
  if (phase === "stalled") return t("session.sleeping.tooltip.stalled", { description: status.description ?? "" })
  const sentences = [
    status.loop_forever === true
      ? t("session.sleeping.tooltip.waiting.loop", {
          description: status.description ?? "",
          time: sleepCountdown(status.wake_at, now),
        })
      : t("session.sleeping.tooltip.waiting", {
          description: status.description ?? "",
          time: sleepCountdown(status.wake_at, now),
        }),
  ]
  const strikes = status.broken_checks ?? 0
  if (strikes > 0)
    sentences.push(t("session.sleeping.tooltip.broken", { count: strikes, limit: status.broken_check_limit ?? strikes }))
  return sentences.join(" ")
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
