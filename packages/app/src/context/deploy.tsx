import type { GlobalDeployStatus } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"

// "restore" (the HEAD~1 rewind of POST /global/restore) leads the bar when a
// restore pipeline runs; the other phases are shared with the deploy pipeline.
export const DEPLOY_PHASES = ["restore", "pull", "install", "build", "manifest", "drain", "restart"] as const
export type DeployPhase = (typeof DEPLOY_PHASES)[number]

type DeployState = GlobalDeployStatus & {
  // the server stopped answering (restart window: process gone, new boot pending)
  down: boolean
  // a reload to pick up the new build has been scheduled
  reloading: boolean
  // this page lived through the server going silent during an active deploy:
  // the rebooted server answering reloads it, while pages opened after the
  // restart already have the new build and should not
  restarted: boolean
}

const POLL_INTERVAL_MS = 2_000
// Heartbeat while no deploy is known to run. Deploy visibility must not
// depend on the event stream: a deploy restart is exactly what breaks that
// stream on long-lived pages, and the browser can keep refusing to reconnect
// for a long while afterwards. Polling the viewed server is the authoritative
// path, so a deploy that starts on a degraded page still surfaces.
const IDLE_POLL_INTERVAL_MS = 5_000
// Grace before reloading so a deploy event announcing the next phase can still
// beat the poll (a failed restart re-announces its error).
const RELOAD_DELAY_MS = 1_500

export const { use: useDeploy, provider: DeployProvider } = createSimpleContext({
  name: "Deploy",
  init: () => {
    const global = useGlobal()
    const server = useServer()

    const [store, setStore] = createStore({
      servers: {} as Record<ServerConnection.Key, DeployState | undefined>,
      // startedAt of the deploy whose card the user dismissed
      dismissed: {} as Record<ServerConnection.Key, number>,
    })

    // The deploy state to surface for a server: hidden once its failure —
    // or its in-flight progress — is dismissed; stays visible through the
    // restart window until the reload.
    const active = (key: ServerConnection.Key) => {
      const status = store.servers[key]
      if (!status) return undefined
      if (status.startedAt !== undefined && store.dismissed[key] === status.startedAt) return undefined
      return status
    }

    const current = () => active(server.key)

    const dismiss = () => {
      const status = store.servers[server.key]
      if (!status) return
      if (status.startedAt !== undefined) setStore("dismissed", server.key, status.startedAt)
      else setStore("servers", server.key, undefined)
    }

    const applyStatus = (key: ServerConnection.Key, status: GlobalDeployStatus) => {
      const previous = store.servers[key]
      if (previous?.reloading) return
      // The rebooted server answering at all means the boot is done — the
      // overlay's job ends there. "resume" (background session restore) is
      // deliberately not surfaced: it re-drives interrupted turns in the
      // background and says nothing a reload must wait for. The boot-change
      // reload in server-sdk covers the normal restart path; this branch is
      // the retry net for when the stream misses the boot change. Graceful
      // shutdown keeps answering polls with a fresh idle state before the
      // process exits, and reloading on that would flash the app mid-deploy.
      if (status.phase === "resume" || (status.phase === "idle" && !status.error)) {
        if (previous && previous.restarted) {
          setStore("servers", key, { ...previous, phase: "restart", down: true, reloading: true })
          setTimeout(() => location.reload(), RELOAD_DELAY_MS)
        } else {
          setStore("servers", key, undefined)
        }
        return
      }
      if (status.error) {
        // a failure always surfaces, even over a dismissed progress card
        delete store.dismissed[key]
      }
      setStore("servers", key, { ...status, down: false, reloading: false, restarted: previous?.restarted ?? false })
    }

    const markDown = (key: ServerConnection.Key) => {
      const status = store.servers[key]
      if (status && status.phase !== "idle" && !status.reloading) {
        setStore("servers", key, { down: true, restarted: true })
      }
    }

    const fetchStatus = (conn: ServerConnection.Any) => {
      const key = ServerConnection.key(conn)
      void global
        .ensureServerCtx(conn)
        .sdk.client.global.deploy.status()
        .then((result) => {
          if (result.data) applyStatus(key, result.data)
        })
        .catch(() => markDown(key))
    }

    createEffect(() => {
      const cleanups: Array<() => void> = []
      onCleanup(() => cleanups.forEach((fn) => fn()))
      for (const conn of server.list) {
        const key = ServerConnection.key(conn)
        const sdk = global.ensureServerCtx(conn).sdk
        // Deploy events ride the /global/event stream as "global"-directory
        // markers, so phase changes arrive live; the ring replays them to
        // clients reconnecting mid-deploy.
        const unsub = sdk.event.listen((event) => {
          if (event.name !== "global") return
          const payload = event.details as { type?: string; properties?: Partial<GlobalDeployStatus> }
          if (payload.type !== "server.deploy") return
          if (!payload.properties?.phase) return
          applyStatus(key, payload.properties as GlobalDeployStatus)
        })
        // Catch deploys whose start event was missed (stream gap, page opened
        // mid-deploy on a fresh connection without a replay cursor).
        const offReconnect = sdk.onReconnect(() => fetchStatus(conn))
        cleanups.push(unsub, offReconnect)
        fetchStatus(conn)
      }
    })

    // Poll status so progress survives missed events and failures flip the
    // entry to "down" until the restarted server answers. While a deploy is
    // live every connection is watched (their stored status stays fresh for a
    // server switch); otherwise only the viewed server is heartbeated at the
    // idle rate — the overlay never renders for any other connection.
    createEffect(() => {
      const watching = server.list.filter((conn) => {
        const status = store.servers[ServerConnection.key(conn)]
        return status && status.phase !== "idle"
      })
      const polled = watching.length
        ? watching
        : server.list.filter((conn) => ServerConnection.key(conn) === server.key)
      const tick = () => polled.forEach(fetchStatus)
      tick()
      const id = setInterval(tick, watching.length ? POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS)
      onCleanup(() => clearInterval(id))
    })

    return {
      active,
      current,
      dismiss,
    }
  },
})

export type DeployApi = ReturnType<typeof useDeploy>
