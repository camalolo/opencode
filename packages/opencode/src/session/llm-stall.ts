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

// Arms a self-rescheduling rejection timer: fires only when global LLM silence
// exceeds the window; any bump elsewhere defers the verdict to what remains.
function armStallTimer(paused: () => boolean, ms: () => number, onError: (message: string) => void) {
  const arm = () => {
    const windowMs = ms()
    if (windowMs <= 0) return
    const remaining = windowMs - (Date.now() - llmActivity.at)
    timerId = setTimeout(() => {
      if (paused()) return arm()
      if (Date.now() - llmActivity.at >= windowMs)
        return onError(
          `LLM stream stalled: no LLM traffic for ${Math.round((Date.now() - llmActivity.at) / 1000)}s across the whole session (ceiling ${windowMs}ms)`,
        )
      arm()
    }, Math.max(remaining, 250))
  }
  let timerId: ReturnType<typeof setTimeout> | undefined
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
            if (!item.done) noteActivity()
            const type = (item.value as { type?: string }).type
            if (type === "tool-call") paused = true
            if (RESUME_TYPES.has(type ?? "")) paused = false
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
