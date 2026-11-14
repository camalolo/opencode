import { expect, test } from "bun:test"
import { mkdir, utimes, writeFile } from "node:fs/promises"
import path from "path"
import { classifyCheck, observeProblem } from "@/session/sleep-scheduler"
import { conditionClock, conditionSelfMatch } from "@/tool/sleep"
import { SleepCheck } from "@/tool/sleep-check"
import { SleepTool } from "@/tool/sleep"
import { ToolJsonSchema } from "@/tool/json-schema"
import { tmpdir } from "../fixture/fixture"

// Typed checks compile to POSIX sh and are refused on win32, so every suite
// that compiles a typed variant is POSIX-only here; only the custom
// passthrough is platform-independent.
const POSIX = process.platform === "win32" ? test.skip : test

/**
 * Mirrors SessionSleepScheduler.runCheck: /bin/sh -c, combined output, state
 * piped into the predicate. Real processes, no mocks — the compiled triple
 * must satisfy the engine's own verdict logic.
 */
const sh = async (script: string, stdin = "") => {
  const proc = Bun.spawn(["/bin/sh", "-c", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  proc.stdin.write(stdin)
  proc.stdin.end()
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return { exitCode: proc.exitCode ?? undefined, output: stdout + stderr, timedOut: false }
}

const compile = (check: SleepCheck.Check) => {
  const result = SleepCheck.compileCheck(check)
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.reason)
  return result.compiled
}

/** Full check pipeline against the real world: observe, then predicate on the state document. */
const judge = async (compiled: SleepCheck.Compiled) => {
  const observed = await sh(compiled.observe)
  const problem = observeProblem(observed)
  expect(problem).toBeUndefined()
  return classifyCheck(await sh(compiled.predicate, observed.output))
}

// ---------------------------------------------------------------------------
// output_marker
// ---------------------------------------------------------------------------

POSIX("output_marker compiles the blessed shape", () => {
  const compiled = compile({ type: "output_marker", command: "make build", marker: "done" })
  expect(compiled.observe).toBe("make build 2>&1")
  expect(compiled.predicate).toBe(
    `grep -qF -- 'done' && { echo 'done: done'; exit 0; }; echo waiting for 'done' in command output; exit 1`,
  )
  expect(compiled.met_example).toBe("done")
  expect(compiled.human).toBe(`output of make build contains "done"`)
})

POSIX("output_marker fires on the marker and waits without it", async () => {
  expect(await judge(compile({ type: "output_marker", command: `echo alpha beta`, marker: "beta" }))).toMatchObject({
    kind: "met",
  })

  const unmet = compile({ type: "output_marker", command: `echo alpha beta`, marker: "gamma" })
  expect(await judge(unmet)).toMatchObject({ kind: "unmet" })
  expect(await sh(unmet.predicate, "alpha beta")).toMatchObject({ exitCode: 1 })
})

POSIX("output_marker survives shell-hostile markers", async () => {
  const command = `echo "it's 100% (ok); next"`
  const marker = `it's 100% (ok); next`
  expect(await judge(compile({ type: "output_marker", command, marker }))).toMatchObject({ kind: "met" })
  expect(await judge(compile({ type: "output_marker", command, marker: `it's 100% (fail)` }))).toMatchObject({
    kind: "unmet",
  })
  expect(await judge(compile({ type: "output_marker", command: `echo 'say "hi" now'`, marker: `say "hi" now` }))).toMatchObject({
    kind: "met",
  })
})

POSIX("output_marker refuses empty and multi-line markers", () => {
  expect(SleepCheck.compileCheck({ type: "output_marker", command: "x", marker: "" })).toMatchObject({ ok: false })
  expect(SleepCheck.compileCheck({ type: "output_marker", command: "x", marker: "a\nb" })).toMatchObject({
    ok: false,
    reason: "marker must be a single line",
  })
  expect(SleepCheck.compileCheck({ type: "output_marker", command: "", marker: "x" })).toMatchObject({ ok: false })
})

// ---------------------------------------------------------------------------
// file_contains
// ---------------------------------------------------------------------------

POSIX("file_contains fires on the pattern and waits without it", async () => {
  await using tmp = await tmpdir()
  const log = path.join(tmp.path, "build.log")
  await writeFile(log, "started\ntarget-token\n")

  expect(await judge(compile({ type: "file_contains", path: log, pattern: "target-token" }))).toMatchObject({
    kind: "met",
  })
  const unmet = compile({ type: "file_contains", path: log, pattern: "missing-token" })
  expect(await judge(unmet)).toMatchObject({ kind: "unmet" })
})

POSIX("file_contains handles paths with spaces", async () => {
  await using tmp = await tmpdir()
  const dir = path.join(tmp.path, "my dir")
  await mkdir(dir)
  const log = path.join(dir, "log.txt")
  await writeFile(log, "token here\n")
  expect(await judge(compile({ type: "file_contains", path: log, pattern: "token here" }))).toMatchObject({
    kind: "met",
  })
})

POSIX("file_contains refuses empty path and pattern", () => {
  expect(SleepCheck.compileCheck({ type: "file_contains", path: "", pattern: "x" })).toMatchObject({ ok: false })
  expect(SleepCheck.compileCheck({ type: "file_contains", path: "/x", pattern: "" })).toMatchObject({ ok: false })
})

// ---------------------------------------------------------------------------
// process_exited
// ---------------------------------------------------------------------------

POSIX("process_exited compiles the bracket-escaped shape", () => {
  const compiled = compile({ type: "process_exited", pattern: "work.sh" })
  expect(compiled.observe).toBe(`pgrep -f '[w]ork.sh' 2>/dev/null || true`)
  expect(compiled.predicate).toBe(`grep -q . && { echo still running; exit 1; }; echo process exited`)
  expect(compiled.met_example).toBe("")
  expect(conditionSelfMatch(compiled.observe)).toBeUndefined()
})

POSIX("process_exited reports met on empty state without any process", async () => {
  const compiled = compile({ type: "process_exited", pattern: "sleepprobe-xyz" })
  expect(classifyCheck(await sh(compiled.predicate, ""))).toMatchObject({ kind: "met" })
})

POSIX("process_exited tracks a real process from running to exited", async () => {
  const proc = Bun.spawn(["sleep", "419"])
  const compiled = compile({ type: "process_exited", pattern: "sleep 419" })
  expect(await judge(compiled)).toMatchObject({ kind: "unmet" })

  proc.kill()
  await proc.exited
  expect(await judge(compiled)).toMatchObject({ kind: "met" })
})

POSIX("process_exited refuses patterns the bracket escape cannot make safe", () => {
  for (const pattern of ["", "-foo", "^foo", "\\foo", "[f]oo", "/usr/bin/foo", "foo("]) {
    const result = SleepCheck.compileCheck({ type: "process_exited", pattern })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain("pattern")
  }
})

// ---------------------------------------------------------------------------
// url_status
// ---------------------------------------------------------------------------

const curlIt = process.platform === "win32" || !Bun.which("curl") ? test.skip : test

curlIt("url_status fires on the expected status and waits on others", async () => {
  const server = Bun.serve({ port: 0, fetch: () => new Response("hi", { status: 201 }) })
  try {
    const url = `http://127.0.0.1:${server.port}/status`
    expect(await judge(compile({ type: "url_status", url, expect: 201 }))).toMatchObject({ kind: "met" })

    const unmet = compile({ type: "url_status", url, expect: 500 })
    expect(await judge(unmet)).toMatchObject({ kind: "unmet" })
    const observed = await sh(unmet.observe)
    expect(observed.output).toBe("201")
    const judged = await sh(unmet.predicate, observed.output)
    expect(judged.exitCode).toBe(1)
    expect(judged.output).toContain("url status: 201")
  } finally {
    server.stop(true)
  }
})

POSIX("url_status refuses non-http urls and non-status codes", () => {
  expect(SleepCheck.compileCheck({ type: "url_status", url: "ftp://x", expect: 200 })).toMatchObject({ ok: false })
  expect(SleepCheck.compileCheck({ type: "url_status", url: "example.com", expect: 200 })).toMatchObject({
    ok: false,
  })
  for (const code of [99, 600, 200.5]) {
    expect(SleepCheck.compileCheck({ type: "url_status", url: "http://x", expect: code })).toMatchObject({
      ok: false,
    })
  }
})

// ---------------------------------------------------------------------------
// file_quiet
// ---------------------------------------------------------------------------

POSIX("file_quiet reports met on an old write and unmet on a fresh one", async () => {
  await using tmp = await tmpdir()
  const log = path.join(tmp.path, "watch.log")
  await writeFile(log, "x\n")

  const compiled = compile({ type: "file_quiet", path: log, seconds: 30 })
  expect(await judge(compiled)).toMatchObject({ kind: "unmet" })

  const past = new Date(Date.now() - 60_000)
  await utimes(log, past, past)
  expect(await judge(compiled)).toMatchObject({ kind: "met" })
})

POSIX("file_quiet treats a missing file as quiet and fabricates its own met example", async () => {
  await using tmp = await tmpdir()
  const compiled = compile({ type: "file_quiet", path: path.join(tmp.path, "never-created.log"), seconds: 30 })
  // Missing file reads as mtime 0: met. At arm time the live probe turns this
  // into the "condition already met" refusal, so a typo'd path cannot arm.
  expect(await judge(compiled)).toMatchObject({ kind: "met" })
  // The fabricated positive is a timestamp from the epoch: infinitely old.
  expect(classifyCheck(await sh(compiled.predicate, compiled.met_example))).toMatchObject({ kind: "met" })
})

POSIX("file_quiet embeds engine-generated clock arithmetic the agent never wrote", () => {
  const compiled = compile({ type: "file_quiet", path: "/x", seconds: 30 })
  expect(compiled.predicate).toContain("date +%s")
  // conditionClock must therefore gate custom predicates only — a typed
  // check's generated clock arithmetic is trusted by construction.
  expect(conditionClock(compiled.predicate)).toContain("$(date")
})

POSIX("file_quiet refuses multi-line paths", () => {
  expect(SleepCheck.compileCheck({ type: "file_quiet", path: "a\nb", seconds: 30 })).toMatchObject({ ok: false })
})

// ---------------------------------------------------------------------------
// custom passthrough
// ---------------------------------------------------------------------------

test("custom passes the triple through verbatim", () => {
  const result = SleepCheck.compileCheck({
    type: "custom",
    observe: "echo state",
    predicate: "grep -q done || { echo waiting; exit 1; }",
    met_example: "state done",
  })
  expect(result.ok).toBe(true)
  if (!result.ok) return
  expect(result.compiled.observe).toBe("echo state")
  expect(result.compiled.predicate).toBe("grep -q done || { echo waiting; exit 1; }")
  expect(result.compiled.met_example).toBe("state done")
})

// ---------------------------------------------------------------------------
// Arm-time gate invariants over every typed shape
// ---------------------------------------------------------------------------

POSIX("every compiled typed check passes the arm-time shell gates", () => {
  const checks: SleepCheck.Check[] = [
    { type: "output_marker", command: "make build", marker: "done" },
    { type: "file_contains", path: "/var/log/build.log", pattern: "done" },
    { type: "process_exited", pattern: "work.sh" },
    { type: "url_status", url: "https://example.com/health", expect: 200 },
    { type: "file_quiet", path: "/var/log/build.log", seconds: 300 },
  ]
  for (const check of checks) {
    const compiled = compile(check)
    expect(conditionSelfMatch(compiled.observe)).toBeUndefined()
    expect(conditionSelfMatch(compiled.predicate)).toBeUndefined()
  }
})

test("the tool-facing JSON schema renders the union as a discriminated anyOf", () => {
  const schema = ToolJsonSchema.fromTool({ parameters: SleepTool.SleepUntilParameters } as never)
  const check = schema.properties?.check as { anyOf: Array<{ type: string; properties: Record<string, unknown> }> }
  const kinds = check.anyOf.map((variant) => variant.properties.type)
  expect(kinds).toHaveLength(6)
  for (const kind of kinds) expect(kind).toBeDefined()
  expect(schema.required).toContain("check")
  expect(schema.required).toContain("description")
})
