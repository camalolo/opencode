import { describe, expect, test } from "bun:test"
import { createScrollPreservation } from "@/pages/session/timeline/scroll-preservation"

// Minimal scroll-container stub: the preservation logic only touches these
// four members.
function fakeViewport(initial: { height: number; client: number; top: number }) {
  const viewport = {
    scrollHeight: initial.height,
    clientHeight: initial.client,
    scrollTop: initial.top,
  }
  return viewport
}

type Harness = ReturnType<typeof createHarness>
function createHarness() {
  const viewport = fakeViewport({ height: 5000, client: 400, top: 3000 })
  const events: { from: number; to: number }[] = []
  let gesturing = false
  let anchored = false
  const preservation = createScrollPreservation({
    viewport: () => viewport,
    gesturing: () => gesturing,
    anchored: () => anchored,
    onRestore: (from, to) => events.push({ from, to }),
  })
  return {
    viewport,
    events,
    preservation,
    gesturing(value: boolean) {
      gesturing = value
    },
    anchored(value: boolean) {
      anchored = value
    },
    // Simulate the user (or an anchor write) scrolling: updates the trusted offset.
    scrollTo(top: number) {
      viewport.scrollTop = top
      preservation.trackScroll(top, false, false)
    },
    // Simulate the browser clamping scrollTop during a height collapse.
    clamp(top: number) {
      viewport.scrollTop = top
    },
  }
}

describe("scroll preservation", () => {
  test("restores the viewport after a collapse-and-regrow throws it to the top", () => {
    const h = createHarness()
    h.scrollTo(3000)

    // Height collapses; the browser clamps scrollTop hard.
    h.viewport.scrollHeight = 500
    h.clamp(100)
    h.preservation.handleResize()
    // Nothing to restore onto while collapsed (target = min(3000, 100) = 100).
    expect(h.viewport.scrollTop).toBe(100)
    expect(h.events).toEqual([])

    // Height comes back: the trusted offset is re-applied.
    h.viewport.scrollHeight = 5000
    h.preservation.handleResize()
    expect(h.viewport.scrollTop).toBe(3000)
    expect(h.events).toEqual([{ from: 100, to: 3000 }])
  })

  test("undoes a partial-height clamp back to the best available position", () => {
    const h = createHarness()
    h.scrollTo(3500)
    h.viewport.scrollHeight = 3200
    h.clamp(2800) // browser clamp: 3200 - 400
    h.preservation.handleResize()
    // 2800 is already the deepest legal offset — no forced move, no event.
    expect(h.viewport.scrollTop).toBe(2800)
    expect(h.events).toEqual([])
  })

  test("leaves the viewport alone when the shrink happened above and nothing clamped", () => {
    const h = createHarness()
    h.scrollTo(1000)
    h.viewport.scrollHeight = 3800
    h.preservation.handleResize()
    expect(h.viewport.scrollTop).toBe(1000)
    expect(h.events).toEqual([])
  })

  test("skips restoration while bottom anchoring owns the position", () => {
    const h = createHarness()
    h.anchored(true)
    h.scrollTo(3000)
    h.viewport.scrollHeight = 500
    h.clamp(100)
    h.viewport.scrollHeight = 5000
    h.clamp(0)
    h.preservation.handleResize()
    expect(h.viewport.scrollTop).toBe(0)
    expect(h.events).toEqual([])
  })

  test("skips restoration while the user is actively scrolling", () => {
    const h = createHarness()
    h.gesturing(true)
    h.scrollTo(3000)
    h.viewport.scrollHeight = 3200
    h.clamp(2800)
    h.viewport.scrollHeight = 5000
    h.clamp(0)
    h.preservation.handleResize()
    expect(h.viewport.scrollTop).toBe(0)
    expect(h.events).toEqual([])
  })

  test("a clamp-tainted position during churn never becomes the trusted offset", () => {
    const h = createHarness()
    h.scrollTo(3000)
    // Churn clamp lands at 100 with no gesture: trackScroll must ignore it.
    h.preservation.trackScroll(100, true, true)
    h.viewport.scrollHeight = 5000
    h.preservation.handleResize()
    expect(h.viewport.scrollTop).toBe(3000)
  })

  test("a genuine user scroll updates the trusted offset", () => {
    const h = createHarness()
    h.scrollTo(3000)
    h.scrollTo(1200)
    h.viewport.scrollHeight = 500
    h.clamp(100)
    h.viewport.scrollHeight = 5000
    h.preservation.handleResize()
    expect(h.viewport.scrollTop).toBe(1200)
  })
})
