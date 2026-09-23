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
//
// ---
//
// Scroll writer inventory for the timeline viewport — every scrollTop change
// must be attributable to one of these. Diagnose against this list before
// adding any new scroll mechanism.
//
// 1. Virtualizer (virtual-core): end anchoring (`anchorTo: "end"` +
//    `followOnAppend`), wasAtEnd resize compensation, scrollToIndex/ToEnd
//    reconcile. Owns bottom follow and measurement-churn compensation. Its
//    writes pass through the app's scrollToFn, which pre-writes the sizer
//    height (clamp guard) and adopts the offset here via markTrusted.
// 2. This preserver: undoes genuine clamps after content-height collapses
//    (skipped while bottom-anchored or gesturing). Emits the `clamp-restore`
//    diag event; if that never fires in real usage, this module can be
//    retired.
// 3. The user: wheel/touch/pointer/key gestures, adopted via trackScroll.
// 4. The browser clamp itself: reduces scrollTop when scrollHeight drops
//    below the viewport bottom. Not a writer we control — (2) undoes it.
// 5. NOT native browser scroll anchoring — the session's auto-scroll hook
//    hard-disables it on the timeline viewport (inline `overflow-anchor:
//    "none"`), so it was never a writer here. The "sent to the top on
//    reconnect" report traced to a project-list echo store write landing in
//    the reconnect resync window (see project-list-sync.ts applyServerList),
//    not to any scroll writer.

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
