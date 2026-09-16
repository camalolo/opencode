import type { Message, UserMessage } from "@opencode-ai/sdk/v2"
import { createMemo, createResource, createSignal, onCleanup, untrack, type Accessor } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { useSync } from "@/context/sync"
import { same } from "@/utils/same"

const emptyUserMessages: UserMessage[] = []
const sessionFreshness = 15_000
const resyncRetryBaseMs = 1_000
const resyncRetryMaxMs = 15_000

export function createTimelineModel(input: {
  sessionID: Accessor<string | undefined>
  revertMessageID: Accessor<string | undefined>
}) {
  const serverSync = useServerSync()
  const sync = useSync()
  let refreshFrame: number | undefined
  let refreshTimer: number | undefined
  // A stream epoch requests one forced resync; if that resync fails, no new
  // epoch arrives until the NEXT gap, so the retry loop below is the only
  // thing standing between the user and a silently stale timeline.
  const [resyncing, setResyncing] = createSignal(false)
  let resyncTimer: ReturnType<typeof setTimeout> | undefined
  let resyncRun = 0

  const forceResync = (sessionID: string) => {
    const run = ++resyncRun
    if (resyncTimer !== undefined) {
      clearTimeout(resyncTimer)
      resyncTimer = undefined
    }
    setResyncing(true)
    const attempt = async (failures: number) => {
      if (run !== resyncRun || input.sessionID() !== sessionID) return
      try {
        await sync().session.sync(sessionID, { force: true })
      } catch {
        if (run !== resyncRun || input.sessionID() !== sessionID) return
        const delay = Math.min(resyncRetryBaseMs * 2 ** failures, resyncRetryMaxMs)
        resyncTimer = setTimeout(() => void attempt(failures + 1), delay)
        return
      }
      if (run !== resyncRun) return
      setResyncing(false)
    }
    void attempt(0)
  }

  // Re-bumped by the sync context on every bridged stream gap; when it moves,
  // the open chat force-resyncs instead of trusting its cached store.
  let seenEpoch = serverSync().streamEpoch()
  const [resource] = createResource(
    () => [input.sessionID(), serverSync().streamEpoch()] as const,
    ([id, epoch]) => {
      clearRefresh()
      if (!id) return
      const forced = epoch !== seenEpoch
      seenEpoch = epoch

      const cached = untrack(() => sync().data.message[id] !== undefined)
      const stale = forced || (cached && !serverSync().session.fresh(id, sessionFreshness))

      refreshFrame = requestAnimationFrame(() => {
        refreshFrame = undefined
        refreshTimer = window.setTimeout(() => {
          refreshTimer = undefined
          if (input.sessionID() !== id) return
          untrack(() => {
            if (stale) forceResync(id)
          })
        }, 0)
      })

      return sync().session.sync(id)
    },
  )
  const messages = createMemo(() => {
    const id = input.sessionID()
    return id ? (sync().data.message[id] ?? []) : []
  })
  const ready = createMemo(() => {
    const id = input.sessionID()
    return !id || isTimelineReady(sync().data.message[id], serverSync().session.history.loading(id))
  })
  const userMessages = createMemo(() => selectUserMessages(messages()), emptyUserMessages, { equals: same })
  const visibleUserMessages = createMemo(
    () => {
      return selectVisibleUserMessages(userMessages(), input.revertMessageID())
    },
    emptyUserMessages,
    { equals: same },
  )
  const more = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.more(id) : false
  })
  const loading = createMemo(() => {
    const id = input.sessionID()
    return id ? sync().session.history.loading(id) : false
  })
  const loadOlder = async (options?: { before?: () => void; after?: (done: boolean) => void }) => {
    return loadOlderTimeline({
      sessionID: input.sessionID,
      more,
      loading,
      loadMore: (sessionID) => sync().session.history.loadMore(sessionID),
      before: options?.before,
      after: options?.after,
    })
  }

  onCleanup(clearRefresh)

  return {
    history: { loadOlder, loading, more },
    lastUserMessage: createMemo(() => visibleUserMessages().at(-1)),
    messages,
    ready,
    resyncing,
    resource,
    userMessages,
    visibleUserMessages,
  }

  function clearRefresh() {
    if (refreshFrame !== undefined) cancelAnimationFrame(refreshFrame)
    if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
    refreshFrame = undefined
    refreshTimer = undefined
    resyncRun++
    if (resyncTimer !== undefined) clearTimeout(resyncTimer)
    resyncTimer = undefined
    setResyncing(false)
  }
}

export function selectUserMessages(messages: Message[]) {
  return messages.filter((message): message is UserMessage => message.role === "user")
}

export function isTimelineReady(messages: Message[] | undefined, loading: boolean) {
  return messages !== undefined && (messages.some((message) => message.role === "user") || !loading)
}

export function selectVisibleUserMessages(messages: UserMessage[], revertMessageID?: string) {
  if (!revertMessageID) return messages
  const boundary = messages.findIndex((message) => message.id === revertMessageID)
  return boundary < 0 ? messages : messages.slice(0, boundary)
}

export async function loadOlderTimeline(input: {
  sessionID: Accessor<string | undefined>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: (sessionID: string) => Promise<void>
  before?: () => void
  after?: (done: boolean) => void
}) {
  const id = input.sessionID()
  if (!id || !input.more() || input.loading()) return

  input.before?.()
  await input.loadMore(id).catch((error) => {
    if (input.sessionID() === id) input.after?.(true)
    throw error
  })
  if (input.sessionID() !== id) return
  input.after?.(true)
}

// Pages backward until the store holds the full transcript. A page that adds
// nothing ends the loop: without that guard a stuck cursor would spin forever.
export async function loadFullHistoryTimeline(input: {
  sessionID: Accessor<string | undefined>
  more: Accessor<boolean>
  loading: Accessor<boolean>
  loadMore: () => Promise<unknown>
  size: Accessor<number>
}) {
  const id = input.sessionID()
  if (!id) return
  let previous = input.size()
  while (input.sessionID() === id && input.more() && !input.loading()) {
    await input.loadMore()
    if (input.sessionID() !== id) return
    const count = input.size()
    if (count <= previous) return
    previous = count
  }
}
