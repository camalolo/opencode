// Undoes browser scroll clamps caused by transient content-height collapses.
//
// A resync storm can shrink the virtual content for a frame (rows dropped or
// hidden pending rehydration, stale→fresh re-measures); the browser clamps
// scrollTop into the shrunk height, and when the height comes back nothing
// restores it — the viewport lands at the top or is thrown toward the bottom
// with no user input. The preserver tracks the last trusted scroll offset and
// re-applies it after height changes, undoing the clamp only (it never moves
// the viewport when the browser did not).
//
// Bottom anchoring owns the position when active, and an active user gesture
// always wins: restoration is skipped in both cases.

export function createScrollPreservation(options: {
  viewport: () => HTMLElement | null | undefined
  gesturing: () => boolean
  anchored: () => boolean
  onRestore?: (from: number, to: number) => void
}) {
  let stableTop = -1
  let observer: ResizeObserver | undefined

  const handleResize = () => {
    const root = options.viewport()
    if (!root || stableTop < 0) return
    if (options.gesturing() || options.anchored()) return
    const maxTop = Math.max(0, root.scrollHeight - root.clientHeight)
    const target = Math.min(stableTop, maxTop)
    if (target - root.scrollTop > 2) {
      options.onRestore?.(root.scrollTop, target)
      root.scrollTop = target
    }
  }

  return {
    observe: (element: HTMLElement) => {
      observer ??= new ResizeObserver(handleResize)
      observer.observe(element)
    },
    disconnect: () => {
      observer?.disconnect()
      observer = undefined
    },
    handleResize,
    // Programmatic scrolls by the virtualizer (resize compensation, bottom
    // re-anchoring, follow corrections) are deliberate content-stabilizing
    // moves, not clamps. Adopt them as the trusted offset: `trackScroll`
    // deliberately ignores non-gesture jumps, so without this the trusted
    // position goes stale and restoration fights the virtualizer, bouncing
    // the viewport between the two writers on every row re-measure.
    markTrusted: (top: number) => {
      const root = options.viewport()
      const maxTop = root ? Math.max(0, root.scrollHeight - root.clientHeight) : Number.MAX_SAFE_INTEGER
      stableTop = Math.max(0, Math.min(top, maxTop))
    },
    // A huge displacement without a user gesture during churn is a clamp
    // artifact, not a position the user chose — keep the trusted offset.
    trackScroll: (top: number, jumped: boolean, stale: boolean) => {
      if (jumped && stale) return
      stableTop = top
    },
  }
}
