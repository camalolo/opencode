export * as BrowserDaemon from "./daemon"

import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import net from "node:net"
import { accessSync, chmodSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { arch, platform, tmpdir } from "node:os"

type Connection = { type: "unix"; path: string } | { type: "tcp"; host: string; port: number }

type Pending = {
  resolve: (data: any) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const REQUEST_TIMEOUT_MS = 60_000
const DAEMON_MAX_AGE_MS = 6 * 60 * 60 * 1000
const SUPERVISOR_INTERVAL_MS = 15 * 60 * 1000
const KEEP_MAX_TABS = 8
const KEEP_NEWEST_TABS = 2
const TAB_GRACE_MS = 10 * 60 * 1000
const TAB_STALE_MS = 60 * 60 * 1000

// Matches the binary path of playwright's bundled headless chromium so the
// orphan sweep can never hit a real Chrome / Chromium / Electron install.
const CHROMIUM_PATTERN = /ms-playwright[/\\]chromium|chrome-headless-shell/

const instanceId = Math.random().toString(36).slice(2)

let socket: net.Socket | null = null
let connecting: Promise<net.Socket> | null = null
let pending = new Map<string, Pending>()
let reqId = 0
let spawning: Promise<void> | null = null
let startedAt = 0
let lastUse = 0
let supervisor: NodeJS.Timeout | null = null

export function session(): string {
  const override = process.env.OPENCODE_BROWSER_AGENT_SESSION?.trim()
  return override || `opencode-${instanceId}`
}

export function daemonVersion(): string | null {
  try {
    const root = packageRoot()
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? null
  } catch {
    return null
  }
}

export function connectionInfo(): Connection {
  const socketOverride = process.env.OPENCODE_BROWSER_AGENT_SOCKET?.trim()
  if (socketOverride) return { type: "unix", path: socketOverride }
  const hostOverride = process.env.OPENCODE_BROWSER_AGENT_HOST?.trim()
  const portOverride = parseEnvNumber(process.env.OPENCODE_BROWSER_AGENT_PORT)
  const transportOverride = process.env.OPENCODE_BROWSER_AGENT_TRANSPORT?.toLowerCase()
  const forceTcp = transportOverride === "tcp" || process.env.OPENCODE_BROWSER_AGENT_TCP === "1"
  if (hostOverride || portOverride !== null || forceTcp || platform() === "win32") {
    return { type: "tcp", host: hostOverride || "127.0.0.1", port: portOverride ?? portForSession(session()) }
  }
  // Mirror the daemon's own socket placement: it refuses to start without a
  // runtime dir, binding under <dir>/agent-browser/<session>.sock.
  const dir = socketDir()
  if (dir) return { type: "unix", path: join(dir, "agent-browser", `${session()}.sock`) }
  return { type: "unix", path: join(tmpdir(), `agent-browser-${session()}.sock`) }
}

// The daemon keeps its socket/pid/state files under a runtime dir when one
// exists (AGENT_BROWSER_SOCKET_DIR or XDG_RUNTIME_DIR), falling back to flat
// tmpdir paths.
function socketDir(): string | null {
  return process.env.AGENT_BROWSER_SOCKET_DIR?.trim() || process.env.XDG_RUNTIME_DIR?.trim() || null
}

export function pidfile(): string {
  const dir = socketDir()
  if (dir) return join(dir, "agent-browser", `${session()}.pid`)
  return join(tmpdir(), `agent-browser-${session()}.pid`)
}

function parseEnvNumber(value: string | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

// Same derivation as the agent-browser daemon uses for its TCP transport, so
// the client only needs the pinned AGENT_BROWSER_SESSION to meet the daemon.
function portForSession(name: string): number {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i)
    hash |= 0
  }
  return 49152 + Math.abs(hash) % 16383
}

function packageRoot(): string {
  // resolved points at <root>/package.json
  return join(createRequire(import.meta.url).resolve("agent-browser/package.json"), "..")
}

function daemonCommand(): { path: string; args: string[] } {
  const override = process.env.OPENCODE_BROWSER_AGENT_DAEMON?.trim()
  if (override) return override.endsWith(".js") ? { path: process.execPath, args: [override] } : { path: override, args: ["daemon"] }
  const root = packageRoot()
  const binary = join(root, "bin", `agent-browser-${binaryPlatform()}-${arch}${platform() === "win32" ? ".exe" : ""}`)
  if (existsSync(binary)) {
    if (platform() !== "win32" && !isExecutable(binary)) chmodSync(binary, 0o755)
    return { path: binary, args: ["daemon"] }
  }
  // Fallback mirrors the external plugin's spawn: the JS entry detects daemon
  // mode from AGENT_BROWSER_DAEMON=1, no argument needed.
  return { path: process.execPath, args: [join(root, "dist", "daemon.js")] }
}

// Bun blocks package lifecycle scripts, so the binary may exist but not be
// executable (postinstall normally fixes the exec bit).
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function binaryPlatform(): string {
  if (platform() !== "linux") return platform()
  for (const name of [`ld-musl-${arch}.so.1`, process.arch === "arm64" ? "ld-musl-aarch64.so.1" : "ld-musl-x86_64.so.1"]) {
    if (existsSync(`/lib/${name}`)) return "linux-musl"
  }
  return "linux"
}

function connect(): Promise<net.Socket> {
  const target = connectionInfo()
  return new Promise((resolve, reject) => {
    const created =
      target.type === "unix" ? net.createConnection(target.path) : net.createConnection({ host: target.host, port: target.port })
    created.once("connect", () => resolve(created))
    created.once("error", (error) => reject(error))
  })
}

async function ensureSpawned(): Promise<void> {
  if (spawning) return await spawning
  await sweepOrphans()
  spawning = new Promise<void>((resolve) => {
    const { path, args } = daemonCommand()
    const child = spawn(path, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, AGENT_BROWSER_SESSION: session(), AGENT_BROWSER_DAEMON: "1" },
    })
    startedAt = Date.now()
    // The daemon is a shared per-server resource: it outlives this process by
    // design (browser state survives server restarts) and is reclaimed by the
    // supervisor's age-based recycle instead of a parent process.
    child.unref()
    child.once("spawn", () => resolve())
    child.once("error", (error) => {
      if (process.env.OPENCODE_BROWSER_DEBUG) console.error(`[browser] daemon spawn failed: ${error.message}`)
      resolve()
    })
  }).finally(() => {
    spawning = null
  })
  return await spawning
}

async function ensureConnection(): Promise<net.Socket> {
  if (socket && !socket.destroyed) return socket
  if (connecting) return await connecting
  connecting = doConnect().finally(() => {
    connecting = null
  })
  return await connecting
}

async function doConnect(): Promise<net.Socket> {
  let active = await tryConnect()
  if (!active) {
    await ensureSpawned()
    // A cold daemon takes several seconds to bind (binary init + browser
    // runtime checks), so poll generously before giving up.
    for (let attempt = 0; attempt < 120 && !active; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      active = await tryConnect()
    }
  }
  if (!active) {
    const target = connectionInfo()
    const label = target.type === "unix" ? target.path : `${target.host}:${target.port}`
    throw new Error(`Could not connect to agent-browser daemon at ${label}.`)
  }
  active.setNoDelay(true)
  let buffer = ""
  active.on("data", (chunk) => {
    buffer += chunk.toString("utf8")
    while (true) {
      const idx = buffer.indexOf("\n")
      if (idx === -1) return
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (!msg || msg.id === undefined) continue
      const id = String(msg.id)
      const waiter = pending.get(id)
      if (!waiter) continue
      pending.delete(id)
      clearTimeout(waiter.timer)
      if (!msg.success) waiter.reject(new Error(msg.error || "Agent browser error"))
      else waiter.resolve(msg.data)
    }
  })
  active.on("close", () => {
    if (socket === active) socket = null
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("Agent browser connection closed"))
    }
    pending.clear()
  })
  active.on("error", () => {})
  startSupervisor()
  return active
}

function tryConnect(): Promise<net.Socket | null> {
  return connect().catch(() => null)
}

// Low-level request used by both the public API and the supervisor itself.
async function command(action: string, payload: Record<string, unknown> = {}): Promise<any> {
  const active = await ensureConnection()
  const id = `a${++reqId}`
  lastUse = Date.now()
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(id)) return
      pending.delete(id)
      reject(new Error("Timed out waiting for agent-browser response"))
    }, REQUEST_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    active.write(JSON.stringify({ id, action, ...payload }) + "\n")
  })
}

function startSupervisor() {
  if (supervisor) return
  supervisor = setInterval(() => {
    void supervise()
  }, SUPERVISOR_INTERVAL_MS)
  supervisor.unref?.()
}

// Recycles an over-age daemon (replaces the fleet's systemd RuntimeMaxSec) and
// reclaims abandoned tabs (replaces the fleet's cleanup timer). The daemon
// itself is left running across opencode restarts so browser state survives
// deploys; only age and tab hoarding trigger work here.
async function supervise(): Promise<void> {
  if (pending.size > 0 || !socket || socket.destroyed) return
  if (startedAt > 0 && Date.now() - startedAt > DAEMON_MAX_AGE_MS) {
    startedAt = 0
    try {
      await recycle()
    } catch {}
    return
  }
  if (Date.now() - lastUse > TAB_STALE_MS) return
  try {
    await sweepTabs()
  } catch {}
}

async function recycle(): Promise<void> {
  const active = socket
  if (active && !active.destroyed) {
    // Fire-and-forget: the daemon exits 0 on "close"; the close event resets
    // client state. Give the browser a generous window to shut down cleanly
    // before we destroy the socket and SIGTERM the daemon (orphans, if any,
    // are swept right after).
    active.write(JSON.stringify({ id: `close-${++reqId}`, action: "close" }) + "\n")
    await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), 8000)
      active.once("close", () => {
        clearTimeout(timer)
        resolve(undefined)
      })
    })
    if (!active.destroyed) active.destroy()
  }
  const pid = readDaemonPid()
  if (pid) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  await sweepOrphans()
}

// Kills playwright-bundled chromium processes whose ancestry does not reach a
// live daemon — port of the fleet's agent-browser-cleanup.sh tree-orphan
// sweep. Roots are the pids of every live daemon known on this user's
// runtime dirs (not just our session): another session's daemon owns its
// chromium as much as ours does. Linux only; graceful "close" handles the
// other platforms.
async function sweepOrphans(): Promise<void> {
  if (platform() !== "linux") return
  const procs = chromiumProcs()
  if (procs.length === 0) return
  const roots = daemonPids()
  const owned = new Set<number>()
  if (roots.size > 0) {
    const byPid = new Map(procs.map((proc) => [proc.pid, proc]))
    let changed = true
    while (changed) {
      changed = false
      for (const proc of procs) {
        if (owned.has(proc.pid)) continue
        if (roots.has(proc.ppid) || (byPid.has(proc.ppid) && owned.has(proc.ppid))) {
          owned.add(proc.pid)
          changed = true
        }
      }
    }
  }
  const orphans = procs.filter((proc) => !owned.has(proc.pid)).map((proc) => proc.pid)
  if (orphans.length === 0) return
  for (const pid of orphans) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const alive = new Set(chromiumProcs().map((proc) => proc.pid))
    const remaining = orphans.filter((pid) => alive.has(pid))
    if (remaining.length === 0) return
    if (i === 29) {
      for (const pid of remaining) {
        try {
          process.kill(pid, "SIGKILL")
        } catch {}
      }
    }
  }
}

// Live daemon pids from every pidfile we know about (our runtime dir and the
// legacy flat tmpdir layout).
function daemonPids(): Set<number> {
  const dirs = [socketDir() ? join(socketDir()!, "agent-browser") : null, tmpdir()].filter(Boolean)
  const pids = new Set<number>()
  for (const dir of dirs) {
    let entries: string[] = []
    try {
      entries = readdirSync(dir!)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith(".pid")) continue
      try {
        const pid = Number(readFileSync(join(dir!, entry), "utf8").trim())
        if (Number.isInteger(pid) && pid > 0) {
          process.kill(pid, 0)
          pids.add(pid)
        }
      } catch {}
    }
  }
  return pids
}

function readDaemonPid(): number | null {
  try {
    const pid = Number(readFileSync(pidfile(), "utf8").trim())
    if (!Number.isInteger(pid) || pid <= 0) return null
    process.kill(pid, 0)
    return pid
  } catch {
    return null
  }
}

function chromiumProcs(): { pid: number; ppid: number }[] {
  const result: { pid: number; ppid: number }[] = []
  let entries: string[] = []
  try {
    entries = readdirSync("/proc")
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8")
      if (!CHROMIUM_PATTERN.test(cmdline)) continue
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])
      result.push({ pid: Number(entry), ppid })
    } catch {}
  }
  return result
}

// Port of the cleanup script's tab-hoard + stale-tab sweeps: renderers cost
// 150-400MB each, and nothing but this reclaim ever closes parallel-research
// tabs. In-memory access state; after a process restart the 10min grace
// window protects every tab until real usage evidence accumulates again.
const tabAccess = new Map<string, { first: number; last: number }>()

async function sweepTabs(): Promise<void> {
  const data = await command("tab_list", {})
  const tabs: { index: number; url: string; title: string; active: boolean }[] = Array.isArray(data?.tabs) ? data.tabs : []
  if (tabs.length === 0) {
    tabAccess.clear()
    return
  }
  const now = Date.now()
  const seen = new Set(tabs.map((tab) => tab.url))
  for (const url of [...tabAccess.keys()]) {
    if (!seen.has(url)) tabAccess.delete(url)
  }
  for (const tab of tabs) {
    const state = tabAccess.get(tab.url)
    if (!state) tabAccess.set(tab.url, { first: now, last: now })
    else if (tab.active) state.last = now
  }
  const active = tabs.findIndex((tab) => tab.active)
  const keep = new Set<number>([active])
  for (let i = 0; i < KEEP_NEWEST_TABS; i++) keep.add(tabs.length - 1 - i)
  tabs.forEach((tab, idx) => {
    const state = tabAccess.get(tab.url)!
    if (now - state.first < TAB_GRACE_MS) keep.add(idx)
  })
  const close: number[] = []
  for (let idx = tabs.length - 1; idx >= 0; idx--) {
    if (keep.has(idx)) continue
    const state = tabAccess.get(tabs[idx].url)!
    if (now - state.last > TAB_STALE_MS) close.push(idx)
    else if (tabs.length > KEEP_MAX_TABS) close.push(idx)
  }
  for (const idx of close) {
    try {
      await command("tab_close", { index: idx })
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

export function status(): { session: string; connection: Connection; version: string | null; started: boolean } {
  return { session: session(), connection: connectionInfo(), version: daemonVersion(), started: startedAt > 0 }
}

export async function healthy(): Promise<{ connected: boolean; error?: string }> {
  try {
    await command("tab_list", {})
    return { connected: true }
  } catch (error) {
    return { connected: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export { command }
