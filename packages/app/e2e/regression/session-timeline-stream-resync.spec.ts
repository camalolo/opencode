import { expect, test, type Page } from "@playwright/test"
import {
  assistantMessage,
  partDelta,
  partUpdated,
  setupTimeline,
  userMessage,
} from "../performance/timeline-stability/fixture"

const streamPart = "prt_reconnect_stream"

async function openStreamingTurn(page: Page) {
  // A busy assistant message with no completed time seeds the session as busy,
  // mirroring a turn that is mid-flight when the page loads.
  const timeline = await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([], { completed: false })],
  })
  await timeline.transport.waitForConnection()
  // A streaming text part looks like what the server emits mid-turn: time
  // started, not yet finalized.
  await timeline.send(partUpdated({ id: streamPart, type: "text", text: "before gap ", time: { start: 1700000001500 } }))
  await timeline.waitForPart(streamPart)
  await expect(page.locator(`[data-timeline-part-id="${streamPart}"]`)).toContainText("before gap")
  return timeline
}

test("deltas keep appending after a mid-stream reconnect", async ({ page }) => {
  const timeline = await openStreamingTurn(page)
  const connections = await timeline.transport.connections()
  const first = connections.at(-1)!

  // The connection dies while the turn is streaming (tab away, network drop).
  await timeline.transport.error("away")
  const second = await timeline.transport.waitForConnection({ after: first.id })
  expect(second.id).toBeGreaterThan(first.id)

  // The reconnect fires a full-state resync (snapshot path); wait until it ran.
  await expect
    .poll(() => page.evaluate(() => (window as any).__timelineDiag?.some((e: any) => e.type === "resync") ?? false))
    .toBe(true)
  await timeline.settle(10)

  // The model keeps streaming on the reconnected stream.
  await timeline.send(partDelta(streamPart, "after reconnect"))
  await expect(page.locator(`[data-timeline-part-id="${streamPart}"]`)).toContainText(
    "before gap after reconnect",
    { timeout: 5_000 },
  )
})
