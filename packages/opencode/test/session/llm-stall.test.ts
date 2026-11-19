import { afterEach, describe, expect, test } from "bun:test"
import { NamedError } from "@opencode-ai/core/util/error"
import { SessionRetry } from "../../src/session/retry"

// The module reads its ceiling at import time — keep the defaults explicit so
// the numbers below are self-describing.
process.env.OPENCODE_LLM_STALL_MS = "900000"
process.env.OPENCODE_LLM_TOOL_STALL_MS = "0"
const { stallGuard, llmActivity } = await import("../../src/session/llm-stall")

const ACTUAL_NOW = Date.now
const ACTUAL_SET_TIMEOUT = globalThis.setTimeout
const ACTUAL_CLEAR_TIMEOUT = globalThis.clearTimeout
const ACTUAL_SET_INTERVAL = globalThis.setInterval
const ACTUAL_CLEAR_INTERVAL = globalThis.clearInterval

const CEILING = 900_000
const HOUR = 3_600_000

type FakeTimer = { id: number; at: number; fn: () => void }

let now = 0
let timers: FakeTimer[] = []
let nextId = 1

function fakeTime() {
  now = 1_700_000_000_000
  timers = []
  nextId = 1
  Date.now = () => now
  globalThis.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++
    timers.push({ id, at: now + Number(ms ?? 0), fn })
    return id
  }) as unknown as typeof setTimeout
  globalThis.clearTimeout = ((id: number) => {
    timers = timers.filter((timer) => timer.id !== id)
  }) as unknown as typeof clearTimeout
  globalThis.setInterval = (() => nextId++) as unknown as typeof setInterval
  globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval
}

function restoreTime() {
  Date.now = ACTUAL_NOW
  globalThis.setTimeout = ACTUAL_SET_TIMEOUT
  globalThis.clearTimeout = ACTUAL_CLEAR_TIMEOUT
  globalThis.setInterval = ACTUAL_SET_INTERVAL
  globalThis.clearInterval = ACTUAL_CLEAR_INTERVAL
}

// Fires every armed timer once, in scheduling order; callbacks may arm more.
function fireAll() {
  const batch = timers
  timers = []
  for (const timer of batch) timer.fn()
}

type Event = { type?: string }

function never(): AsyncIterable<Event> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<Event>>(() => {}) }
    },
  }
}

async function rejection(pending: Promise<unknown>): Promise<Error> {
  return pending.then(
    () => {
      throw new Error("expected the guard to reject")
    },
    (error: Error) => error,
  )
}

function from<T>(items: T[]): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: () => Promise.resolve(i < items.length ? { done: false, value: items[i++] } : { done: true, value: undefined }),
      }
    },
  }
}

afterEach(() => restoreTime())

describe("llm stall guard", () => {
  test("a stale session clock does not insta-fail a fresh await", async () => {
    fakeTime()
    llmActivity.at = now - 10 * HOUR // last LLM traffic was before a long tool run

    const pending = stallGuard(never())[Symbol.asyncIterator]().next()
    pending.catch(() => {})

    // Regression: the old arithmetic inherited the stale clock and armed a
    // 250ms verdict ("no LLM traffic for 36000s") for a request that had only
    // just been issued.
    expect(timers).toHaveLength(1)
    expect(timers[0].at - now).toBe(CEILING)
  })

  test("a timer that fires on time still reports a stall", async () => {
    fakeTime()
    llmActivity.at = now

    const pending = stallGuard(never())[Symbol.asyncIterator]().next()
    now += CEILING
    fireAll()

    await expect(pending).rejects.toThrow(/^LLM stream stalled: no LLM traffic for 900s across the whole session \(ceiling 900000ms\)$/)
  })

  test("a timer that fires hours late is a suspension, not a stall", async () => {
    fakeTime()
    llmActivity.at = now

    const pending = stallGuard(never())[Symbol.asyncIterator]().next()
    now += CEILING + 2 * HOUR // the machine slept through the deadline
    fireAll()

    const error = await rejection(pending)
    expect(error.message).toMatch(/stream timed out after the process was suspended/)
    expect(error.message).not.toMatch(/stalled/)
    // The retry path must actually pick it up — this is the difference between
    // the turn recovering on wake and the session dying for a bogus stall.
    const parsed = new NamedError.Unknown({ message: error.message }).toObject()
    expect(SessionRetry.retryable(parsed, "camalolo")).toBeDefined()
  })

  test("sibling LLM traffic defers the verdict to the remaining window", async () => {
    fakeTime()
    llmActivity.at = now

    const pending = stallGuard(never())[Symbol.asyncIterator]().next()
    now += CEILING - 300_000
    llmActivity.at = now // a sibling leg delivered bytes
    now += 300_000 // this leg's deadline arrives on time
    fireAll()

    // Only 300s of the window elapsed since the sibling's traffic.
    expect(timers).toHaveLength(1)
    expect(timers[0].at - now).toBe(600_000)

    now += 600_000
    fireAll()
    await expect(pending).rejects.toThrow(/stream stalled: no LLM traffic for 900s/)
  })

  test("a tool-call pauses the watchdog until the stream resumes", async () => {
    fakeTime()
    llmActivity.at = now

    const iter = stallGuard(from([{ type: "tool-call" }]))[Symbol.asyncIterator]()
    const first = await iter.next()

    expect(first.done).toBe(false)
    expect(timers).toHaveLength(0)

    const pending = iter.next()
    pending.catch(() => {})
    expect(timers).toHaveLength(0) // unbounded by default: no timer while a tool runs
  })
})
