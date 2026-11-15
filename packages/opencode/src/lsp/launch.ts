import type { ChildProcessWithoutNullStreams } from "child_process"
import fs from "node:fs"
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

export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const [bin, routed] = route(cmd, args)
  const proc = Process.spawn([bin, ...routed], {
    ...cfg,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  return proc
}
