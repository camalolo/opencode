// Stall watchdog for LLM provider streams.
//
// Contract (ratified with user 2026-08-27): "any LLM activity anywhere in the
// session — main chat, subagent, subsubagent, or waiting for a tool — resets
// the ceiling". Two consequences, both implemented here:
//
// 1. Per-window: the countdown arms fresh for every pulled part; tool-execution
//    windows are excluded entirely (a `tool-call` pauses the watchdog until the
//    next non-tool event — results are awaited unbounded by default).
// 2. Session-wide: every delivered byte bumps ONE shared monotonic clock, and a
//    leg may only be declared stalled if the WHOLE PROCESS has seen zero LLM
//    traffic for the ceiling. Parallel/slow legs therefore cannot be executed
//    while any sibling still receives tokens (production evidence: zai/glm-5.3
//    swarm legs thinking silently >5min while siblings streamed fine), while a
//    network/API-wide death still fails into the retry/halt path instead of
//    hanging sessions busy forever (2026-08-26 incident: 1h+ pinned spinner).
// 3. Wall-clock time only counts while the process is actually running. The
//    shared clock goes stale for reasons that say nothing about a socket: a
//    long tool run (tools are awaited outside the stream), an idle session, or
//    the whole machine sleeping. Each await therefore anchors its own countdown
//    (sibling traffic still extends it), and a timer that fires far past its
//    deadline is treated as proof of suspension — the request was parked, not
//    silent, so it surfaces as a retryable timeout and the normal retry path
//    re-issues it. (2026-11-19 desktop incident: a 900s deadline armed at
//    09:58 fired at 12:52 after system sleep and reported "no LLM traffic for
//    10460s" — the session died for a stall that never happened.)
//
// Tunables: OPENCODE_LLM_STALL_MS default 900_000 (0 disables); OPENCODE_LLM_TOOL_STALL_MS
// optional ceiling for silent tool runs, default 0 (disabled).
export const STALL_MS = Number(process.env.OPENCODE_LLM_STALL_MS ?? 900_000)
export const STALL_TOOL_MS = Number(process.env.OPENCODE_LLM_TOOL_STALL_MS ?? 0)

const RESUME_TYPES = new Set(["tool-result", "tool-error", "step-start", "step-finish", "finish"])

// Process-global recency of the last byte delivered by any guarded stream.
export const llmActivity = { at: Date.now() }

function noteActivity() {
  llmActivity.at = Date.now()
}

// How late a timer may fire before we treat the lateness itself as proof that
// the event loop was frozen (system sleep/standby, a debugger pause, a swap
// storm). Far below the ceiling, far above any normal scheduling hiccup.
const FREEZE_GRACE_MS = 60_000

// Arms a self-rescheduling rejection timer: fires only when global LLM silence
// exceeds the window; any bump elsewhere defers the verdict to what remains.
function armStallTimer(paused: () => boolean, ms: () => number, onError: (message: string) => void) {
  // Silence that predates this await is not evidence about this leg: a long
  // tool run or an idle session leaves the shared clock hours old, and the old
  // arithmetic armed that staleness as a 250ms verdict. Anchor the countdown to
  // the await itself; noteActivity() bumps still extend it for sibling legs.
  const anchor = Date.now()
  let timerId: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    const windowMs = ms()
    if (windowMs <= 0) return
    const delay = Math.max(windowMs - (Date.now() - Math.max(llmActivity.at, anchor)), 250)
    const dueAt = Date.now() + delay
    timerId = setTimeout(() => {
      if (paused()) return arm()
      // Fired hours late: the machine slept (or the process was frozen), so the
      // measured silence is suspension time, not upstream behaviour. A request
      // parked that long is dead — fail with a transport-shaped, retryable
      // message so SessionRetry re-issues it instead of halting the turn.
      if (Date.now() - dueAt > FREEZE_GRACE_MS)
        return onError(
          `LLM stream timed out after the process was suspended (no LLM traffic for ${Math.round((Date.now() - Math.max(llmActivity.at, anchor)) / 1000)}s)`,
        )
      const silentMs = Date.now() - Math.max(llmActivity.at, anchor)
      if (silentMs >= windowMs)
        return onError(
          `LLM stream stalled: no LLM traffic for ${Math.round(silentMs / 1000)}s across the whole session (ceiling ${windowMs}ms)`,
        )
      arm()
    }, delay)
  }
  arm()
  return () => clearTimeout(timerId)
}

export function stallGuard<T extends { type?: string }>(iterable: AsyncIterable<T>): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const iter = iterable[Symbol.asyncIterator]()
      let paused = false
      const limit = () => (paused ? STALL_TOOL_MS : STALL_MS)
      return {
        async next() {
          let disarm: (() => void) | undefined
          try {
            // Progressive visibility while THIS leg is quiet, so near-misses
            // and future kills carry timing proof instead of guesswork.
            const startedAt = Date.now()
            const quietProbe =
              limit() > 0
                ? setInterval(() => {
                    if (!paused) console.warn(`[llm] stream silent ${Math.round((Date.now() - startedAt) / 1000)}s (watchdog still listening; session-wide silence decides)`)
                  }, 30_000)
                : undefined

            const item = await Promise.race([
              iter.next().then((value) => {
                clearInterval(quietProbe)
                return value
              }),
              new Promise<never>((_, reject) => {
                disarm = armStallTimer(
                  () => paused,
                  limit,
                  (message) => reject(new Error(message)),
                )
              }),
            ])
            if (!item.done) {
              noteActivity()
              const type = (item.value as { type?: string }).type
              if (type === "tool-call") paused = true
              if (RESUME_TYPES.has(type ?? "")) paused = false
            }
            return item
          } finally {
            disarm?.()
          }
        },
        return: (value) => iter.return?.(value) ?? Promise.resolve({ done: true as const, value }),
        throw: (reason) => iter.throw?.(reason) ?? Promise.reject(reason),
      }
    },
  }
}
