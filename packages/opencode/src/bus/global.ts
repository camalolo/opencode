import { EventEmitter } from "events"
import { Identifier } from "@/id/id"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

// SSE resume buffer. Mobile clients on cellular networks lose TCP silently;
// without a cursor they must refetch all state on every reconnect. The bus
// retains the newest events so a reconnecting stream can replay "everything
// after X" via Last-Event-ID. Event IDs are `evt_` + monotonic time-hex +
// random tail at fixed length, so plain string comparison orders them.
const RING_MAX = Number(process.env.OPENCODE_EVENT_RING_MAX ?? 4096)
const RING_BYTES = 8 * 1024 * 1024

const ring: GlobalEvent[] = []
let ringBytes = 0
// ID of the most recently evicted entry: a cursor at or below it can no
// longer be fully served from the ring.
let evictedNewestId: string | undefined

const sizeOf = (event: GlobalEvent) =>
  (event.directory?.length ?? 0) + JSON.stringify(event.payload).length

function remember(event: GlobalEvent) {
  const id = event.payload?.id
  if (typeof id !== "string") return
  const snapshot = { ...event, payload: { ...event.payload } }
  ring.push(snapshot)
  ringBytes += sizeOf(snapshot)
  while (ring.length > RING_MAX || (ringBytes > RING_BYTES && ring.length > 1)) {
    const evicted = ring.shift()
    if (!evicted) break
    ringBytes -= sizeOf(evicted)
    evictedNewestId = evicted.payload.id
  }
}

/** Events buffered after `afterID`, and whether older ones were already evicted. */
export function replay(afterID: string) {
  return {
    events: ring.filter((event) => typeof event.payload?.id === "string" && event.payload.id > afterID),
    // a cursor at/below the eviction floor means part of the gap is gone:
    // the client must resync instead of trusting a partial replay
    overflow: evictedNewestId !== undefined && afterID < evictedNewestId,
  }
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    remember(event)
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()
