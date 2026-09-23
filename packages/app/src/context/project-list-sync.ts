import { createStore } from "solid-js/store"
import { onCleanup } from "solid-js"
import { Persist, persisted } from "@/utils/persist"
import { ServerConnection, type ServerProjectsSync } from "@/context/server"
import type { ServerSDK } from "@/context/server-sdk"
import type { ServerScope } from "@/utils/server-scope"

type WebEntry = { worktree: string; expanded: boolean }

// Keeps one server's web UI project list in sync across every browser that
// accesses it. Local writes stay optimistic (localStorage-first, push
// fire-and-forget); the server list is authoritative whenever it can be read,
// and `project.list.updated` events converge every other connected client.
//
// First contact migration: when the server list is empty but this browser has
// a locally stored list, the local list is seeded to the server (append-only)
// so the sidebar survives the switch to server-backed storage. The seed runs
// once per browser: afterwards the server list wins, so intentionally emptying
// it on one device is not undone by a stale local list on another. Old servers
// without the project.web* routes fail the initial fetch and the app silently
// keeps its previous browser-local behavior.
export function installProjectListSync(input: {
  conn: ServerConnection.Any
  scope: ServerScope
  sdk: ServerSDK
  setProjectSync: (key: ServerConnection.Key, sync: ServerProjectsSync | undefined) => void
  localEntries: () => Array<{ worktree: string; expanded: boolean }>
  replace: (entries: WebEntry[]) => void
}) {
  const key = ServerConnection.key(input.conn)
  const client = input.sdk.client
  const [flags, setFlags] = persisted(
    Persist.global("web-projects-sync.v1"),
    createStore({ seeded: {} as Record<string, boolean> }),
  )
  const hasSeeded = () => !!flags.seeded[input.scope]
  const markSeeded = () => setFlags("seeded", input.scope, true)

  const normalize = (entries: unknown): WebEntry[] | undefined => {
    if (!Array.isArray(entries)) return
    const result: WebEntry[] = []
    for (const entry of entries) {
      if (typeof entry !== "object" || entry === null) continue
      const record = entry as Record<string, unknown>
      if (typeof record.worktree !== "string" || !record.worktree) continue
      result.push({ worktree: record.worktree, expanded: record.expanded !== false })
    }
    return result
  }

  // Apply a server-provided list. Skip the write when the entries already
  // match: a fresh array re-renders every consumer even when the content is
  // identical, and on reconnect that lands in the same flush as the forced
  // session resync — the combination threw open chats to the top of the
  // timeline (seen as "sent to the start on reconnect").
  const applyServerList = (entries: WebEntry[]) => {
    const current = input.localEntries()
    if (
      current.length === entries.length &&
      current.every((entry, index) => entry.worktree === entries[index].worktree && entry.expanded === entries[index].expanded)
    )
      return
    input.replace(entries)
  }

  const fetchServerList = async (): Promise<WebEntry[] | undefined> => {
    const response = await client.project.webList()
    return normalize(response.data)
  }

  let disposed = false
  let booted = false
  let pending: Promise<void> | undefined
  // Fetch once and converge with the server. Retries on the next mutation if
  // the server could not be reached, so seeding is not lost to a boot race.
  const bootstrap = () => {
    if (booted) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      const remote = await fetchServerList().catch(() => undefined)
      if (!remote || disposed) return
      booted = true
      if (remote.length === 0) {
        if (hasSeeded()) return
        const local = input.localEntries()
        if (local.length === 0) {
          markSeeded()
          return
        }
        const seeded = await client.project
          .webSeed({ projects: local.map((entry) => ({ worktree: entry.worktree, expanded: entry.expanded })) })
          .then((response) => normalize(response.data))
          .catch(() => undefined)
        if (!seeded) return
        markSeeded()
        if (!disposed) applyServerList(seeded)
        return
      }
      markSeeded()
      applyServerList(remote)
    })().finally(() => {
      pending = undefined
    })
    return pending
  }

  const unsubscribe = input.sdk.event.listen((event) => {
    if (event.name !== "global") return
    const payload = event.details
    if (payload.type !== "project.list.updated") return
    const properties = payload.properties as { projects?: unknown } | undefined
    const entries = normalize(properties?.projects)
    if (entries) applyServerList(entries)
  })

  // Missed events while the stream was down (offline, sleep) are bridged by a
  // fresh fetch instead of relying on replay.
  const offReconnect = input.sdk.onReconnect(() => {
    void fetchServerList()
      .then((entries) => {
        if (entries) applyServerList(entries)
      })
      .catch(() => undefined)
  })

  const syncHooks: ServerProjectsSync = {
    open(directory) {
      void bootstrap().then(() => client.project.webOpen({ directory })).catch(() => undefined)
    },
    close(directory) {
      void bootstrap().then(() => client.project.webClose({ directory })).catch(() => undefined)
    },
    expand(directory, expanded) {
      void bootstrap().then(() => client.project.webExpand({ directory, expanded })).catch(() => undefined)
    },
    move(directory, toIndex) {
      void bootstrap().then(() => client.project.webReorder({ directory, index: toIndex })).catch(() => undefined)
    },
  }
  input.setProjectSync(key, syncHooks)

  void bootstrap()

  onCleanup(() => {
    disposed = true
    input.setProjectSync(key, undefined)
    unsubscribe()
    offReconnect()
  })
}
