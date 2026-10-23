import { describe, expect, test } from "bun:test"
import { isSleepStalled } from "./sleep-stall"

describe("isSleepStalled", () => {
  test("non-sleeping or heartbeat-less status is never stalled", () => {
    expect(isSleepStalled(undefined, 1_000)).toBe(false)
    expect(isSleepStalled({ type: "idle" }, 1_000)).toBe(false)
    expect(isSleepStalled({ type: "sleeping", wake_at: 5_000 }, 1_000)).toBe(false)
  })

  test("a due check within the grace window is still healthy", () => {
    const status = { type: "sleeping", wake_at: 1_800_000, next_check_at: 1_000_000, interval_ms: 60_000 }
    // 61s past due: interval*2 grace dominates, still healthy.
    expect(isSleepStalled(status, status.next_check_at! + 61_000)).toBe(false)
    // 121s past due: beyond max(2*60s, 60s) grace.
    expect(isSleepStalled(status, status.next_check_at! + 121_000)).toBe(true)
  })

  test("short intervals still get the 60s floor", () => {
    const status = { type: "sleeping", wake_at: 1_800_000, next_check_at: 1_000_000, interval_ms: 15_000 }
    expect(isSleepStalled(status, status.next_check_at! + 30_000)).toBe(false)
    expect(isSleepStalled(status, status.next_check_at! + 61_000)).toBe(true)
  })
})
