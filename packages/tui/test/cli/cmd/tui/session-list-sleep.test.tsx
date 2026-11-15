/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { mkdir } from "node:fs/promises"
import { onCleanup } from "solid-js"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json, type FetchHandler } from "../../../fixture/tui-sdk"
import { TestTuiContexts } from "../../../fixture/tui-environment"
import type { GlobalEvent, SessionStatus } from "@opencode-ai/sdk/v2"
import { ArgsProvider } from "../../../../src/context/args"
import { KVProvider } from "../../../../src/context/kv"
import { ProjectProvider } from "../../../../src/context/project"
import { SDKProvider } from "../../../../src/context/sdk"
import { SyncProvider } from "../../../../src/context/sync"
import { PermissionProvider } from "../../../../src/context/permission"
import { RouteProvider } from "../../../../src/context/route"
import { LocalProvider } from "../../../../src/context/local"
import { ExitProvider } from "../../../../src/context/exit"
import { DialogProvider } from "../../../../src/ui/dialog"
import { ThemeProvider } from "../../../../src/context/theme"
import { TuiConfigProvider } from "../../../../src/config"
import { ToastProvider } from "../../../../src/ui/toast"
import { registerOpencodeKeymap, OpencodeKeymapProvider } from "../../../../src/keymap"
import { DialogSessionList } from "../../../../src/component/dialog-session-list"

async function wait(fn: () => boolean | Promise<boolean>, timeout = 5000) {
  const start = Date.now()
  while (!(await fn())) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(20)
  }
}

const sessions = [
  {
    id: "ses_sleep_loop",
    projectID: "proj_test",
    directory,
    title: "Loop watcher",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
    location: { directory },
  },
  {
    id: "ses_sleep_stalled",
    projectID: "proj_test",
    directory,
    title: "Stalled watcher",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: Date.now(), updated: Date.now() },
    location: { directory },
  },
]

// Bridged out of the harness once its event source exists.
let emitEvent: ((event: GlobalEvent) => void) | undefined

async function mountDialog(state: string, handler: FetchHandler) {
  const calls = createFetch(handler)
  const events = createEventSource()
  emitEvent = events.emit

  return testRender(
    () => {
      const renderer = useRenderer()
      const keymap = createDefaultOpenTuiKeymap(renderer)
      const resolvedConfig = createTuiResolvedConfig({ keybinds: {}, leader_timeout: 1000 })
      const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
      onCleanup(off)

      return (
        <TestTuiContexts paths={{ state }}>
          <ArgsProvider>
            <TuiConfigProvider config={resolvedConfig}>
              <OpencodeKeymapProvider keymap={keymap}>
                <KVProvider>
                  <ThemeProvider mode="dark">
                    <ToastProvider>
                      <SDKProvider url="http://test" directory={directory} fetch={calls.fetch} events={events.source}>
                        <PermissionProvider>
                          <RouteProvider initialRoute={{ type: "session", sessionID: "ses_sleep_loop" }}>
                            <ProjectProvider>
                              <ExitProvider exit={() => {}}>
                                <SyncProvider>
                                  <LocalProvider>
                                    <DialogProvider>
                                      <DialogSessionList />
                                    </DialogProvider>
                                  </LocalProvider>
                                </SyncProvider>
                              </ExitProvider>
                            </ProjectProvider>
                          </RouteProvider>
                        </PermissionProvider>
                      </SDKProvider>
                    </ToastProvider>
                  </ThemeProvider>
                </KVProvider>
              </OpencodeKeymapProvider>
            </TuiConfigProvider>
          </ArgsProvider>
        </TestTuiContexts>
      )
    },
    { width: 110, height: 30 },
  )
}

const listHandler: FetchHandler = (url) => {
  if (url.pathname === "/session") return json(sessions)
  return undefined
}

const emitStatus = async (sessionID: string, status: SessionStatus) => {
  const event: GlobalEvent = {
    directory,
    project: "proj_test",
    payload: { id: `evt_status_${sessionID}`, type: "session.status", properties: { sessionID, status } },
  }
  // The harness event source attaches its handler asynchronously after mount.
  await wait(() => {
    if (!emitEvent) return false
    try {
      emitEvent(event)
      return true
    } catch {
      return false
    }
  })
}

const frameText = async (app: Awaited<ReturnType<typeof testRender>>) =>
  app
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")

test("session list renders sleeping countdowns, loop and strike badges, and the stalled glyph", async () => {
  await using tmp = await tmpdir()
  await mkdir(`${tmp.path}/state`, { recursive: true })
  await Bun.write(`${tmp.path}/state/kv.json`, "{}")

  const app = await mountDialog(`${tmp.path}/state`, listHandler)

  try {
    const now = Date.now()
    // Loop watcher: ~2h14 left, loop_forever, two broken checks.
    await emitStatus("ses_sleep_loop", {
      type: "sleeping",
      description: "watching ci",
      wake_at: now + 134 * 60_000,
      next_check_at: now + 30_000,
      interval_ms: 60_000,
      loop_forever: true,
      broken_checks: 2,
      broken_check_limit: 5,
      check_kind: "url_status",
    })
    // Stalled watcher: heartbeat 10 minutes overdue.
    await emitStatus("ses_sleep_stalled", {
      type: "sleeping",
      description: "watching build",
      wake_at: now + 3 * 60 * 60_000,
      next_check_at: now - 10 * 60_000,
      interval_ms: 60_000,
    })

    await wait(async () => {
      const rendered = await frameText(app)
      return rendered.includes("∞2h14") && rendered.includes("⏰ !")
    })
    const rendered = await frameText(app)
    expect(rendered).toContain("⏰")
    expect(rendered).toContain("∞2h14")
    expect(rendered).toContain("⚠2")
    expect(rendered).toContain("Stalled watcher")
    expect(rendered).toContain("Loop watcher")
    expect(rendered).toContain("⏰ !")
  } finally {
    app.renderer.destroy()
  }
}, 20000)
