import { describe, expect, test } from "bun:test"
import { isSleepStalled, sleepCountdown, sleepPhase, sleepTooltip } from "./sleep-stall"

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

describe("sleepPhase", () => {
  test("non-sleeping status is always normal", () => {
    expect(sleepPhase(undefined, 1_000)).toBe("normal")
    expect(sleepPhase({ type: "idle" }, 1_000)).toBe("normal")
  })

  test("near deadline when the remaining window is a handful of checks", () => {
    const status = { type: "sleeping", wake_at: 1_800_000, next_check_at: 1_700_000, interval_ms: 60_000 }
    // 30 minutes left and heartbeat alive: well past the 5-interval (5min) near threshold.
    expect(sleepPhase(status, 0)).toBe("normal")
    // 40 seconds left: inside it. Heartbeat is 60s past due, within the 120s grace.
    expect(sleepPhase(status, 1_760_000)).toBe("near")
  })

  test("stalled beats near", () => {
    // At now=200s: heartbeat 200s past due (stalled) AND 300s left (near threshold).
    const status = { type: "sleeping", wake_at: 500_000, next_check_at: 0, interval_ms: 60_000 }
    expect(sleepPhase(status, 200_000)).toBe("stalled")
  })

  test("no wake_at never goes near", () => {
    expect(sleepPhase({ type: "sleeping", next_check_at: 2_100_000, interval_ms: 60_000 }, 2_000_000)).toBe("normal")
  })
})

describe("sleepCountdown", () => {
  test("formats seconds, minutes, hours", () => {
    expect(sleepCountdown(45_000, 0)).toBe("45s")
    expect(sleepCountdown(42 * 60_000, 0)).toBe("42m")
    expect(sleepCountdown(134 * 60_000, 0)).toBe("2h14")
    expect(sleepCountdown(undefined, 0)).toBe("")
    expect(sleepCountdown(-1, 0)).toBe("0s")
  })
})

describe("sleepTooltip", () => {
  const t = (key: string, params?: Record<string, string | number>) =>
    params ? `${key} ${JSON.stringify(params)}` : key

  test("waiting sentence carries description and countdown; loop variant when re-arming", () => {
    const status = { type: "sleeping", description: "ci build", wake_at: 42 * 60_000, interval_ms: 60_000 }
    const plain = sleepTooltip(status, 0, t)
    expect(plain).toContain("tooltip.waiting ")
    expect(plain).toContain('"ci build"')
    expect(sleepTooltip({ ...status, loop_forever: true }, 0, t)).toContain("tooltip.waiting.loop")
  })

  test("stalled replaces the countdown sentence", () => {
    const status = { type: "sleeping", description: "ci", wake_at: 9_000_000, next_check_at: 0, interval_ms: 60_000 }
    const tooltip = sleepTooltip(status, 200_000, t)
    expect(tooltip).toContain("tooltip.stalled")
    expect(tooltip).not.toContain("tooltip.waiting")
  })

  test("broken checks sentence appended with count and limit", () => {
    const status = {
      type: "sleeping",
      description: "ci",
      wake_at: 42 * 60_000,
      interval_ms: 60_000,
      broken_checks: 2,
      broken_check_limit: 5,
    }
    expect(sleepTooltip(status, 0, t)).toContain('"count":2')
    expect(sleepTooltip(status, 0, t)).toContain('"limit":5')
  })
})
