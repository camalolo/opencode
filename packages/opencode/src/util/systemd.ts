// Run one command inside a transient systemd user scope so its memory is
// accounted and capped separately from the opencode service. Scopes are
// siblings of opencode.service, so a runaway child cannot consume the
// server's own cgroup budget. Fail-open: without a usable user systemd
// (containers, desktops) callers spawn exactly as before.
const usable = new Map<string, boolean>()

export type Scope = {
  unit: string
  argv: string[]
}

export function scope(input: {
  prefix: string
  properties: string[]
  disabled?: boolean
  collect?: boolean
}): Scope | undefined {
  if (input.disabled) return undefined
  if (!available(input.properties)) return undefined
  const unit = `${input.prefix}-${crypto.randomUUID()}`
  return {
    unit,
    argv: [
      "systemd-run",
      "--user",
      "--quiet",
      "--scope",
      ...(input.collect ? ["--collect"] : []),
      ...input.properties.flatMap((property) => ["-p", property]),
      "--unit",
      unit,
      "--",
    ],
  }
}

// Fire-and-forget cleanup for aborted commands: systemd stops every process
// left in the scope, including children that escaped the process group.
export function stop(unit: string) {
  Bun.spawn(["systemctl", "--user", "stop", `${unit}.scope`], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
}

// Why a scope ended: "oom-kill" means the kernel killed a process in it for
// exceeding its memory cap. Only readable while the unit is loaded — failed
// scopes keep their record, successful ones disappear on their own.
export function result(unit: string) {
  try {
    const out = Bun.spawnSync(["systemctl", "--user", "show", `${unit}.scope`, "-p", "Result", "--value"], {
      stdin: "ignore",
      stderr: "ignore",
    })
    if (out.exitCode !== 0) return undefined
    return out.stdout.toString().trim() || undefined
  } catch {
    return undefined
  }
}

// Failed transient scopes stay loaded until reset; clear ours after reading
// the result so a crashing command cannot accumulate units.
export function discard(unit: string) {
  void (async () => {
    const stopped = Bun.spawn(["systemctl", "--user", "stop", `${unit}.scope`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    await stopped.exited
    Bun.spawn(["systemctl", "--user", "reset-failed", `${unit}.scope`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
  })().catch(() => {})
}

// Probe with the exact properties the caller will use, so a property the
// local systemd rejects falls back to a plain spawn instead of failing every
// command. systemd-run execs the payload in place; the caller's pid stays.
function available(properties: string[]) {
  const key = properties.join("\n")
  const cached = usable.get(key)
  if (cached !== undefined) return cached
  const ok = process.platform === "linux" && probe(properties)
  usable.set(key, ok)
  return ok
}

function probe(properties: string[]) {
  try {
    return (
      Bun.spawnSync([
        "systemd-run",
        "--user",
        "--quiet",
        "--scope",
        "--collect",
        ...properties.flatMap((property) => ["-p", property]),
        "true",
      ]).exitCode === 0
    )
  } catch {
    return false
  }
}

export * as Systemd from "./systemd"
