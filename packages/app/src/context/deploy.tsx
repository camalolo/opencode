import type { GlobalDeployStatus } from "@opencode-ai/sdk/v2/client"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "./global"
import { ServerConnection, useServer } from "./server"
import { deployHold } from "./deploy-hold"

export const DEPLOY_PHASES = ["pull", "install", "build", "manifest", "drain", "restart", "resume"] as const
export type DeployPhase = (typeof DEPLOY_PHASES)[number]

type DeployState = GlobalDeployStatus & {
  // the server stopped answering (restart window: process gone, new boot pending)
  down: boolean
  // a reload to pick up the new build has been scheduled
  reloading: boolean
  // this page lived through the server going silent during an active deploy:
  // the final idle must reload it, while pages opened after the restart
  // already have the new build and should not
  restarted: boolean
}

const POLL_INTERVAL_MS = 2_000
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
      // startedAt of the failed deploy whose error the user dismissed
      dismissed: {} as Record<ServerConnection.Key, number>,
    })

    // The deploy state to surface for a server: hidden once its failure is
    // dismissed; stays visible through the restart window until the reload.
    const active = (key: ServerConnection.Key) => {
      const status = store.servers[key]
      if (!status) return undefined
      if (status.error && status.startedAt !== undefined && store.dismissed[key] === status.startedAt)
        return undefined
      return status
    }

    const current = () => active(server.key)

    const dismiss = () => {
      const status = store.servers[server.key]
      if (!status?.error) return
      if (status.startedAt !== undefined) setStore("dismissed", server.key, status.startedAt)
      else setStore("servers", server.key, undefined)
    }

    const applyStatus = (key: ServerConnection.Key, status: GlobalDeployStatus) => {
      const previous = store.servers[key]
      if (previous?.reloading) return
      if (status.phase === "idle" && !status.error) {
        deployHold.release(key)
        // Nothing left to show. The boot-change reload in server-sdk covers
        // the normal restart path (while a deploy is held, the boot change
        // leaves the reload to this branch, so the boot resume stays visible);
        // this reload is also the retry net for when the server actually
        // stopped answering. Graceful shutdown keeps answering polls with a
        // fresh idle state before the process exits, and reloading on that
        // would flash the app mid-deploy.
        if (previous && previous.phase !== "idle" && previous.restarted) {
          setStore("servers", key, { ...previous, phase: "restart", down: true, reloading: true })
          setTimeout(() => location.reload(), RELOAD_DELAY_MS)
        }
        return
      }
      if (status.error) deployHold.release(key)
      // restart = waiting for the rebooted process; resume = the rebooted
      // server restoring the sessions the deploy interrupted
      if (status.phase === "restart" || status.phase === "resume") deployHold.mark(key)
      setStore("servers", key, { ...status, down: false, reloading: false, restarted: previous?.restarted ?? false })
    }

    const markDown = (key: ServerConnection.Key) => {
      const status = store.servers[key]
      if (status && status.phase !== "idle" && !status.reloading) {
        setStore("servers", key, { down: true, restarted: true })
        deployHold.mark(key)
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

    // While a deploy is live, poll status so progress survives missed events;
    // failures flip the entry to "down" until the restarted server answers.
    createEffect(() => {
      const watching = server.list.filter((conn) => {
        const status = store.servers[ServerConnection.key(conn)]
        return status && status.phase !== "idle"
      })
      if (watching.length === 0) return
      const tick = () => watching.forEach(fetchStatus)
      tick()
      const id = setInterval(tick, POLL_INTERVAL_MS)
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
