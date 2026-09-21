import { describe, expect, test } from "bun:test"
import { createScrollPreservation } from "./scroll-preservation"

function harness() {
  const viewport = { scrollHeight: 5000, clientHeight: 400, scrollTop: 0 }
  const restorations: Array<{ from: number; to: number }> = []
  const preservation = createScrollPreservation({
    viewport: () => viewport as unknown as HTMLElement,
    gesturing: () => false,
    anchored: () => false,
    onRestore: (from, to) => restorations.push({ from, to }),
  })
  return { viewport, restorations, preservation }
}

describe("scroll preservation", () => {
  test("restores a clamp after content collapses without a gesture", () => {
    const { viewport, restorations, preservation } = harness()
    viewport.scrollTop = 2000
    preservation.trackScroll(2000, false, true)
    viewport.scrollHeight = 2400 // collapse: browser clamps scrollTop upward (toward the top)
    viewport.scrollTop = 1600
    viewport.scrollHeight = 5000 // height comes back; the browser does not undo the clamp
    preservation.handleResize()
    expect(restorations).toEqual([{ from: 1600, to: 2000 }])
    expect(viewport.scrollTop).toBe(2000)
  })

  test("adopts virtualizer programmatic scrolls as the trusted offset", () => {
    const { viewport, restorations, preservation } = harness()
    viewport.scrollTop = 2000
    preservation.trackScroll(2000, false, true)
    // The virtualizer compensates an above-viewport resize: content-stabilizing,
    // goes through scrollToFn, so preservation must adopt it, not fight it.
    preservation.markTrusted(2127)
    viewport.scrollHeight = 5200
    viewport.scrollTop = 2127
    preservation.handleResize()
    expect(restorations).toEqual([])
    expect(viewport.scrollTop).toBe(2127)
  })

  test("stops fighting once the virtualizer correction is adopted mid-oscillation", () => {
    const { viewport, restorations, preservation } = harness()
    viewport.scrollTop = 56349
    preservation.trackScroll(56349, false, true)
    // Stale trusted offset while the virtualizer has already compensated.
    viewport.scrollTop = 56476
    preservation.markTrusted(56476)
    viewport.scrollHeight = 5700
    preservation.handleResize()
    expect(restorations).toEqual([])
    expect(viewport.scrollTop).toBe(56476)
  })

  test("clamps the adopted offset to the document", () => {
    const { viewport, preservation } = harness()
    preservation.markTrusted(Number.MAX_SAFE_INTEGER)
    viewport.scrollTop = 4000
    viewport.scrollHeight = 5000
    preservation.handleResize()
    // maxTop = 4600; the adopted offset was clamped to 4600, not MAX.
    expect(viewport.scrollTop).toBe(4600)
  })

  test("skips restoration while gesturing or bottom-anchored", () => {
    const viewport = { scrollHeight: 5000, clientHeight: 400, scrollTop: 0 }
    const restorations: Array<{ from: number; to: number }> = []
    for (const state of [{ gesturing: true, anchored: false }, { gesturing: false, anchored: true }]) {
      const preservation = createScrollPreservation({
        viewport: () => viewport as unknown as HTMLElement,
        gesturing: () => state.gesturing,
        anchored: () => state.anchored,
        onRestore: (from, to) => restorations.push({ from, to }),
      })
      viewport.scrollTop = 2000
      preservation.trackScroll(2000, false, true)
      viewport.scrollTop = 2300
      viewport.scrollHeight = 5000
      preservation.handleResize()
      expect(viewport.scrollTop).toBe(2300)
    }
    expect(restorations).toEqual([])
  })
})
