import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { BrowserAgent } from "../../src/browser/agent"
import { BrowserDaemon } from "../../src/browser/daemon"

// Real daemon + real chromium: this exercises the actual spawn path, socket
// transport, eval scripts and tab lifecycle that the fleet relies on.
const session = `opencode-test-${Math.random().toString(36).slice(2)}`

let server: ReturnType<typeof Bun.serve>
let url = ""

beforeAll(() => {
  // Isolation: this box runs INSIDE the production opencode server, whose env
  // pins OPENCODE_BROWSER_AGENT_SOCKET to the shared browser. Clear it so the
  // test spawns its own daemon instead of driving the fleet browser.
  delete process.env.OPENCODE_BROWSER_AGENT_SOCKET
  delete process.env.OPENCODE_BROWSER_AGENT_SESSION
  process.env.OPENCODE_BROWSER_AGENT_SESSION = session
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        `<!doctype html><html><head><title>Browser Test</title></head><body>
          <h1 id="title">Hello Browser</h1>
          <input id="name" value="" />
          <button id="btn" onclick="document.getElementById('out').textContent = 'clicked'; console.log('button clicked')">Go</button>
          <div id="out"></div>
          <ul id="items"><li>one</li><li>two</li><li>three</li></ul>
          <script>
            console.log('page loaded')
            setTimeout(() => { throw new Error('boom-from-test-page') }, 100)
          </script>
        </body></html>`,
        { headers: { "content-type": "text/html" } },
      )
    },
  })
  url = `http://127.0.0.1:${server.port}/`
})

afterAll(async () => {
  try {
    await BrowserDaemon.command("close")
  } catch {}
  server?.stop(true)
})

describe("browser daemon integration", () => {
  test(
    "navigates, queries, types, clicks and reads console/errors",
    async () => {
      const navigated = await BrowserAgent.run("navigate", { url }, session)
      expect(navigated.content).toContain(url)

      const tabs = await BrowserAgent.run("get_tabs", {}, session)
      expect(String(tabs.content)).toContain(url)

      const title = await BrowserAgent.run("query", { selector: "#title", mode: "text" }, session)
      expect(title.content).toBe("Hello Browser")

      const pageText = await BrowserAgent.run("query", { mode: "page_text" }, session)
      expect(String(pageText.content)).toContain("Hello Browser")

      const typed = await BrowserAgent.run("type", { selector: "#name", text: "laurent" }, session)
      expect(String(typed.content)).toContain("Typed")
      const value = await BrowserAgent.run("query", { selector: "#name", mode: "value" }, session)
      expect(value.content).toBe("laurent")

      const clicked = await BrowserAgent.run("click", { selector: "#btn" }, session)
      expect(String(clicked.content)).toContain("Clicked")
      const out = await BrowserAgent.run("query", { selector: "#out", mode: "text" }, session)
      expect(out.content).toBe("clicked")

      const list = await BrowserAgent.run("query", { selector: "#items li", mode: "list" }, session)
      expect(String(list.content)).toContain('"count": 3')

      const consoleMessages = await BrowserAgent.run("console", {}, session)
      expect(String(consoleMessages.content)).toContain("page loaded")
      expect(String(consoleMessages.content)).toContain("button clicked")

      await Bun.sleep(300)
      const errors = await BrowserAgent.run("errors", {}, session)
      expect(String(errors.content)).toContain("boom-from-test-page")

      const shot = await BrowserAgent.run("screenshot", {}, session)
      expect(String(shot.content)).toStartWith("data:image/png;base64,")

      const cdp = await BrowserAgent.run("cdp", {}, session)
      expect(String(cdp.content)).toContain("browserWs")
      expect(String(cdp.content)).toContain("httpBase")
    },
    120_000,
  )

  test(
    "tracks tab claims per session",
    () => {
      const claim = BrowserAgent.claimTab(1, "session-a")
      expect(claim).toEqual({ tabId: 1, owner: "session-a" })
      const conflict = BrowserAgent.claimTab(1, "session-b")
      expect("conflict" in conflict).toBe(true)
      const forced = BrowserAgent.claimTab(1, "session-b", true)
      expect(forced).toEqual({ tabId: 1, owner: "session-b" })
      expect(BrowserAgent.listClaims()).toContainEqual({ tabId: 1, owner: "session-b" })
      expect(BrowserAgent.releaseTab(1, "session-b")).toEqual({ tabId: 1, released: true })
      expect(BrowserAgent.listClaims()).toHaveLength(0)
    },
    30_000,
  )

  test(
    "close shuts the daemon down so the next use respawns it",
    async () => {
      const pid = Number(readFileSync(BrowserDaemon.pidfile(), "utf8").trim())
      expect(pid).toBeGreaterThan(0)
      await BrowserDaemon.command("close")
      let alive = true
      for (let i = 0; i < 50 && alive; i++) {
        await Bun.sleep(100)
        try {
          process.kill(pid, 0)
        } catch {
          alive = false
        }
      }
      expect(alive).toBe(false)

      // Lazy respawn: the next request must bring a fresh daemon up.
      const tabs = await BrowserAgent.run("get_tabs", {}, session)
      expect(String(tabs.content)).toContain("[")
    },
    120_000,
  )
})

// Chrome processes of this test's daemon only: ancestry must reach the daemon
// pid, so the box's other agent-browser browsers are never matched.
function procTable(): Map<number, { ppid: number; cmdline: string }> {
  const table = new Map<number, { ppid: number; cmdline: string }>()
  let entries: string[] = []
  try {
    entries = readdirSync("/proc")
  } catch {
    return table
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8")
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
      table.set(Number(entry), { ppid, cmdline })
    } catch {}
  }
  return table
}

function descendsFrom(table: Map<number, { ppid: number; cmdline: string }>, pid: number, ancestor: number): boolean {
  let current = pid
  for (let i = 0; i < 20 && current > 1; i++) {
    if (current === ancestor) return true
    current = table.get(current)?.ppid ?? 0
  }
  return false
}

function browserProcs(daemonPid: number): { pid: number; cmdline: string }[] {
  const table = procTable()
  return [...table]
    .filter(([pid, proc]) => proc.cmdline.includes("agent-browser-chrome-") && descendsFrom(table, pid, daemonPid))
    .map(([pid, proc]) => ({ pid, cmdline: proc.cmdline }))
}

function daemonPid(): number {
  return Number(readFileSync(BrowserDaemon.pidfile(), "utf8").trim())
}

describe("chrome launch args", () => {
  // The port in the MAP replacement is the syntax the fleet relies on to keep
  // a TLS wrapper on an unprivileged port.
  const flags = () => [`--host-resolver-rules=MAP browser-args-test.invalid 127.0.0.1:${server.port}`, "--ignore-certificate-errors"]

  test(
    "default spawn has no custom flags",
    async () => {
      await BrowserAgent.run("get_tabs", {}, session)
      const procs = browserProcs(daemonPid())
      expect(procs.length).toBeGreaterThan(0)
      expect(procs.some((proc) => proc.cmdline.includes("host-resolver-rules"))).toBe(false)
    },
    60_000,
  )

  test(
    "chromeArgs relaunch chrome with the flags and map host:port",
    async () => {
      const before = browserProcs(daemonPid()).map((proc) => proc.pid)
      // Only a chrome launched with the resolver rule can resolve the fake
      // host to the local test server.
      const navigated = await BrowserAgent.run("navigate", { url: "http://browser-args-test.invalid/", chromeArgs: flags() }, session)
      expect(String(navigated.content)).toContain("browser-args-test.invalid")
      const title = await BrowserAgent.run("query", { selector: "#title", mode: "text" }, session)
      expect(title.content).toBe("Hello Browser")

      const procs = browserProcs(daemonPid())
      expect(procs.some((proc) => proc.cmdline.includes("host-resolver-rules=MAP browser-args-test.invalid"))).toBe(true)
      expect(procs.some((proc) => proc.cmdline.includes("ignore-certificate-errors"))).toBe(true)
      const after = procs.map((proc) => proc.pid)
      expect(after.some((pid) => before.includes(pid))).toBe(false)
    },
    120_000,
  )

  test(
    "the same flags reuse the running browser",
    async () => {
      const before = browserProcs(daemonPid()).map((proc) => proc.pid)
      await BrowserAgent.run("navigate", { url, chromeArgs: flags() }, session)
      const after = browserProcs(daemonPid()).map((proc) => proc.pid)
      expect(after.some((pid) => before.includes(pid))).toBe(true)
    },
    60_000,
  )

  test(
    "flags survive a daemon respawn and empty chromeArgs clears them",
    async () => {
      // The daemon drops the socket without answering on close.
      BrowserDaemon.command("close").catch(() => {})
      const pid = Number(readFileSync(BrowserDaemon.pidfile(), "utf8").trim())
      let alive = true
      for (let i = 0; i < 100 && alive; i++) {
        await Bun.sleep(100)
        try {
          process.kill(pid, 0)
        } catch {
          alive = false
        }
      }
      expect(alive).toBe(false)

      const navigated = await BrowserAgent.run("navigate", { url, chromeArgs: flags() }, session)
      expect(String(navigated.content)).toContain(url)
      expect(browserProcs(daemonPid()).some((proc) => proc.cmdline.includes("host-resolver-rules"))).toBe(true)

      const cleared = await BrowserAgent.run("navigate", { url, chromeArgs: [] }, session)
      expect(String(cleared.content)).toContain(url)
      expect(browserProcs(daemonPid()).some((proc) => proc.cmdline.includes("host-resolver-rules"))).toBe(false)
    },
    180_000,
  )
})
