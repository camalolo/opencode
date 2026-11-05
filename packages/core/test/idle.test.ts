import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Idle } from "../src/idle"

// Fast clocks so timing assertions stay well under the test timeout. The
// governor reads these lazily, so runtime env works even though other test
// files may have imported the module first.
const IDLE_AFTER_MS = 60
const QUIET_AFTER_MS = 150
const PACE_MS = 1_000
const SLICE_MS = 100

const env = {
  OPENCODE_IDLE_AFTER_MS: String(IDLE_AFTER_MS),
  OPENCODE_QUIET_AFTER_MS: String(QUIET_AFTER_MS),
  OPENCODE_IDLE_PACE_MS: String(PACE_MS),
  OPENCODE_IDLE_SLICE_MS: String(SLICE_MS),
}
const savedEnv: Record<string, string | undefined> = {}
for (const [key, value] of Object.entries(env)) {
  savedEnv[key] = process.env[key]
  process.env[key] = value
}
afterAll(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})


const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const elapsed = async (effect: Effect.Effect<void>, settle: () => Promise<void>) => {
  const start = Date.now()
  const run = Effect.runPromise(effect)
  await settle()
  await run
  return Date.now() - start
}

describe("Idle", () => {
  test("active immediately after a mark, idle after the no-clients grace", async () => {
    Idle.mark()
    expect(Idle.idle()).toBe(false)
    await sleep(IDLE_AFTER_MS + 50)
    expect(Idle.idle()).toBe(true)
  })

  test("drains pin the fast pace", async () => {
    Idle.drainInc()
    await sleep(IDLE_AFTER_MS + 50)
    expect(Idle.idle()).toBe(false)
    Idle.drainDec()
    await sleep(IDLE_AFTER_MS + 50)
    expect(Idle.idle()).toBe(true)
  })

  test("clients use the long quiet grace", async () => {
    Idle.clientInc()
    await sleep(IDLE_AFTER_MS + 50)
    expect(Idle.idle()).toBe(false)
    await sleep(QUIET_AFTER_MS)
    expect(Idle.idle()).toBe(true)
    Idle.clientDec()
    expect(Idle.idle()).toBe(false)
  })

  test("backgroundDelay is a no-op while active", async () => {
    Idle.mark()
    const took = await elapsed(Idle.backgroundDelay(10), () => sleep(30))
    expect(took).toBeLessThan(60)
  })

  test("backgroundDelay skips stretching when the loop has pending work", async () => {
    await sleep(IDLE_AFTER_MS + 50)
    const took = await elapsed(Idle.backgroundDelay(10, () => true), () => sleep(30))
    expect(took).toBeLessThan(60)
  })

  test("backgroundDelay stretches while idle and wakes early on activity", async () => {
    await sleep(IDLE_AFTER_MS + 50)
    const took = await elapsed(Idle.backgroundDelay(10), () => sleep(300).then(() => Idle.mark()))
    // Stretched toward PACE_MS, but the mark after 300ms must cut the sleep
    // at the next 100ms slice boundary instead of running the full pace.
    expect(took).toBeGreaterThanOrEqual(300)
    expect(took).toBeLessThan(PACE_MS)
  })

  test("backgroundDelay caps at the pace duration while idle", async () => {
    await sleep(IDLE_AFTER_MS + 50)
    const took = await elapsed(Idle.backgroundDelay(10), () => sleep(200))
    expect(took).toBeLessThan(PACE_MS + SLICE_MS + 100)
  })

  test("client and drain counters saturate at zero", () => {
    Idle.clientDec()
    Idle.drainDec()
    expect(Idle.idle()).toBe(false) // just marked active again, and counters never went negative
  })
})
