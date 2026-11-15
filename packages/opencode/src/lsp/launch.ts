import type { ChildProcessWithoutNullStreams } from "child_process"
import fs from "node:fs"
import { Readable, Writable } from "node:stream"
import { Process } from "@/util/process"

type Child = Process.Child & ChildProcessWithoutNullStreams

// npm-installed .bin LSP entries are node-shebang scripts and fleet service PATHs may have no
// `node` — run script entries with the runtime opencode itself is running on
function route(cmd: string, args: string[]): [string, string[]] {
  try {
    const fd = fs.openSync(cmd, "r")
    const head = Buffer.alloc(2)
    fs.readSync(fd, head, 0, 2, 0)
    fs.closeSync(fd)
    if (head.toString("latin1") === "#!") return [process.execPath, [cmd, ...args]]
  } catch {
    // not a local file (bare PATH command) — leave untouched
  }
  return [cmd, args]
}

// Bun's child_process compat drops output of children that write to fd 1 natively (napi CLIs
// like oxlint), so LSP servers must be spawned through Bun.spawn — their stdio is the LSP
// channel and nothing may be lost
export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const [bin, routed] = route(cmd, args)
  const env = cfg?.env === null ? {} : cfg?.env ? { ...process.env, ...cfg.env } : undefined
  const proc = Bun.spawn([bin, ...routed], {
    cwd: cfg?.cwd,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  const child = {
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        try {
          const sink = proc.stdin!
          sink.write(chunk as Buffer)
          sink.flush()
          callback()
        } catch (error) {
          callback(error as Error)
        }
      },
      final(callback) {
        try {
          proc.stdin?.end()
        } catch {
          // already closed
        }
        callback()
      },
    }),
    stdout: Readable.fromWeb(proc.stdout as any),
    stderr: Readable.fromWeb(proc.stderr as any),
    pid: proc.pid,
    get exitCode() {
      return proc.exitCode
    },
    get signalCode() {
      return proc.signalCode
    },
    exited: proc.exited.then((code) => code ?? 0),
    kill(_signal?: NodeJS.Signals | number) {
      try {
        proc.kill()
      } catch {
        // already exited
      }
    },
    ref() {},
    unref() {},
    once(event: string, listener: (...args: any[]) => void) {
      if (event === "exit") proc.exited.then((code) => listener(code ?? 0, null))
      return child
    },
  }

  return child as unknown as Child
}
