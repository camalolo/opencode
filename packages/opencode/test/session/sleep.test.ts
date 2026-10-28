import { Database } from "@opencode-ai/core/database/database"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSleep } from "@opencode-ai/core/session/sleep"
import { SessionSleepTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { eq } from "drizzle-orm"
import path from "path"
import { Config } from "@/config/config"
import type * as Tool from "@/tool/tool"
import { InstanceBootstrap } from "@/project/bootstrap"
import { InstanceStore } from "@/project/instance-store"
import { TestInstance } from "../fixture/fixture"
import { MessageID, SessionID } from "@/session/schema"
import { SessionPrompt } from "@/session/prompt"
import { SessionSleepDelivery, wakeText } from "@/session/sleep-delivery"
import { SessionSleepScheduler } from "@/session/sleep-scheduler"
import { SessionStatus } from "@/session/status"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { conditionClock, conditionSelfMatch, SleepCancelTool, SleepStatusTool, SleepUntilTool } from "@/tool/sleep"
import { pollWithTimeout, testEffect } from "../lib/effect"

const insertSession = (db: Database.Interface["db"], sessionID: string) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({
        id: ProjectV2.ID.make(`prj_${sessionID}`),
        worktree: AbsolutePath.make("/tmp/test"),
        name: "test",
        sandboxes: [],
        time_created: 1,
        time_updated: 1,
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionSchema.ID.make(sessionID),
        project_id: ProjectV2.ID.make(`prj_${sessionID}`),
        slug: sessionID,
        directory: AbsolutePath.make("/tmp/test"),
        title: "test",
        version: "test",
        time_created: 1,
        time_updated: 1,
      })
      .run()
      .pipe(Effect.orDie)
  })

const fakeWithParts = (sessionID: SessionID): SessionV1.WithParts => ({
  info: {
    id: MessageID.make(`msg_fake_${Math.random().toString(36).slice(2)}`),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
  },
  parts: [],
})

// An unmet condition must produce output: a silent exit 1 classifies as a
// broken check and the arm-time probe refuses it.
const unmetWithOutput = process.platform === "win32" ? "echo still waiting & exit 1" : "echo 'still waiting'; exit 1"

// State-check fixtures, portable across cmd.exe and POSIX sh: the observe
// prints a state document; the predicate greps it for the `done` marker on
// stdin, exiting 1 with a progress line while the marker is absent. No quotes
// on the findstr pattern: through `cmd /s /c` a quoted pattern fails to match
// piped stdin.
const observeState = "echo state-abc"
const predicateDone =
  process.platform === "win32"
    ? `findstr done >NUL 2>&1 || (echo still waiting & exit 1)`
    : `grep -q done || { echo 'still waiting'; exit 1; }`
const metExample = "state-abc done"
const stateCheck = { observe: observeState, predicate: predicateDone, met_example: metExample }

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const schedulerIt = testEffect(LayerNode.compile(LayerNode.group([SessionSleepScheduler.node, Database.node])))

const arm = (sessionID: string, overrides: Partial<Parameters<SessionSleepScheduler.Interface["arm"]>[0]> = {}) => {
  const input: Parameters<SessionSleepScheduler.Interface["arm"]>[0] = {
    sessionID: SessionID.make(sessionID),
    condition: "exit 1",
    description: "forum reply appears",
    intervalMs: 60_000,
    timeoutMs: 3_600_000,
    checkTimeoutMs: 30_000,
    cwd: process.cwd(),
    ...overrides,
  }
  return Effect.gen(function* () {
    const scheduler = yield* SessionSleepScheduler.Service
    return yield* scheduler.arm(input)
  })
}

schedulerIt.effect(
  "probe reports exit codes from the condition check",
  () =>
    Effect.gen(function* () {
      const scheduler = yield* SessionSleepScheduler.Service
      const met = yield* scheduler.probe({ condition: "exit 0", cwd: process.cwd() })
      expect(met.exitCode).toBe(0)
      const unmet = yield* scheduler.probe({ condition: "exit 1", cwd: process.cwd() })
      expect(unmet.exitCode).toBe(1)
      const broken = yield* scheduler.probe({ condition: "exit 7", cwd: process.cwd() })
      expect(broken.exitCode).toBe(7)
    }),
  30_000,
)

test("classifyCheck sorts met, unmet, and broken check results", () => {
  const reasonOf = (verdict: SessionSleepScheduler.CheckVerdict) => (verdict.kind === "broken" ? verdict.reason : "")
  expect(SessionSleepScheduler.classifyCheck({ exitCode: 0, output: "", timedOut: false })).toMatchObject({
    kind: "met",
  })
  expect(SessionSleepScheduler.classifyCheck({ exitCode: 1, output: "3/9 done", timedOut: false })).toMatchObject({
    kind: "unmet",
  })
  expect(SessionSleepScheduler.classifyCheck({ exitCode: 7, output: "boom", timedOut: false })).toMatchObject({
    kind: "broken",
  })
  expect(reasonOf(SessionSleepScheduler.classifyCheck({ exitCode: 7, output: "boom", timedOut: false }))).toContain(
    "exit code 7",
  )
  expect(
    SessionSleepScheduler.classifyCheck({ exitCode: undefined, output: "check timed out", timedOut: true }),
  ).toMatchObject({ kind: "broken", reason: "the check timed out" })
  expect(SessionSleepScheduler.classifyCheck({ exitCode: undefined, output: "spawn failed", timedOut: false })).toMatchObject({
    kind: "broken",
    reason: "spawn failed",
  })
  // cmd.exe reports a missing command with exit code 1; the stderr line is the tell.
  expect(
    SessionSleepScheduler.classifyCheck({
      exitCode: 1,
      output: "'foo' is not recognized as an internal or external command,\r\noperable program or batch file.",
      timedOut: false,
    }),
  ).toMatchObject({ kind: "broken" })
  expect(
    reasonOf(
      SessionSleepScheduler.classifyCheck({
        exitCode: 1,
        output: "'foo' is not recognized as an internal or external command,\r\noperable program or batch file.",
        timedOut: false,
      }),
    ),
  ).toContain("command not found")
  // PowerShell phrases a missing command differently but also collapses it to exit code 1.
  expect(
    SessionSleepScheduler.classifyCheck({
      exitCode: 1,
      output: "The term 'foo' is not recognized as the name of a cmdlet, function, script file, or executable program.",
      timedOut: false,
    }),
  ).toMatchObject({ kind: "broken" })
  // POSIX shells exit 127 for a missing command.
  expect(SessionSleepScheduler.classifyCheck({ exitCode: 127, output: "", timedOut: false })).toMatchObject({
    kind: "broken",
  })
  expect(reasonOf(SessionSleepScheduler.classifyCheck({ exitCode: 127, output: "", timedOut: false }))).toContain(
    "command not found",
  )
  // An unmet check must prove it is alive: a silent exit 1 counts as broken.
  expect(SessionSleepScheduler.classifyCheck({ exitCode: 1, output: "", timedOut: false })).toMatchObject({
    kind: "broken",
  })
  expect(reasonOf(SessionSleepScheduler.classifyCheck({ exitCode: 1, output: "   \n\t", timedOut: false }))).toContain(
    "silent check",
  )
})

schedulerIt.effect(
  "arm persists the trigger and get returns the latest row",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_sched_arm")
      const scheduler = yield* SessionSleepScheduler.Service
      const first = yield* arm("ses_sched_arm")
      expect(first.status).toBe("pending")
      const second = yield* arm("ses_sched_arm", { description: "second" })
      const latest = yield* scheduler.get(SessionID.make("ses_sched_arm"))
      expect(latest?.id).toBe(second.id)
      expect(latest?.description).toBe("second")
      const refreshedFirst = yield* SessionSleep.byID(db, first.id)
      expect(refreshedFirst?.status).toBe("cancelled")
    }),
  30_000,
)

schedulerIt.effect(
  "flush fires a met condition and arms nothing for unmet checks",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_sched_fire")
      const scheduler = yield* SessionSleepScheduler.Service
      const trigger = yield* arm("ses_sched_fire", { condition: "exit 0" })

      yield* scheduler.flush()

      const fired = yield* pollWithTimeout(
        Effect.gen(function* () {
          const row = yield* SessionSleep.byID(db, trigger.id)
          return row?.status === "fired" ? row : undefined
        }),
        "trigger never fired",
      )
      expect(fired.lastOutput).toContain("")

      const unmet = yield* arm("ses_sched_fire", { condition: unmetWithOutput, description: "unmet" })
      yield* scheduler.flush()
      const stillPending = yield* SessionSleep.byID(db, unmet.id)
      expect(stillPending?.status).toBe("pending")
      expect(stillPending?.consecutiveFailures).toBe(0)
    }),
  30_000,
)

schedulerIt.effect(
  "repeated broken checks disarm the trigger as failed",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_sched_fail")
      const scheduler = yield* SessionSleepScheduler.Service
      // Tiny interval so every flush finds the row due again immediately.
      const trigger = yield* arm("ses_sched_fail", { condition: "exit 7", intervalMs: 1 })

      for (let i = 0; i < 5; i++) yield* scheduler.flush()

      const failed = yield* pollWithTimeout(
        Effect.gen(function* () {
          const row = yield* SessionSleep.byID(db, trigger.id)
          return row?.status === "failed" ? row : undefined
        }),
        "trigger never disarmed as failed",
      )
      expect(failed.consecutiveFailures).toBeGreaterThanOrEqual(5)
    }),
  30_000,
)

schedulerIt.effect(
  "broken checks accumulate across unmet checks until the breaker trips",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_sched_breaker")
      const scheduler = yield* SessionSleepScheduler.Service
      const trigger = yield* arm("ses_sched_breaker", { condition: "exit 7", intervalMs: 1 })

      // Two broken checks, then a healthy unmet one: the unmet result must not
      // reset the broken count, or a flaky condition could evade the breaker
      // forever by alternating.
      yield* scheduler.flush()
      yield* scheduler.flush()
      yield* SessionSleep.recordNotMet(db, trigger.id, "3/9 done")
      const current = yield* SessionSleep.byID(db, trigger.id)
      expect(current?.consecutiveFailures).toBe(2)

      for (let i = 0; i < 3; i++) yield* scheduler.flush()

      const failed = yield* pollWithTimeout(
        Effect.gen(function* () {
          const row = yield* SessionSleep.byID(db, trigger.id)
          return row?.status === "failed" ? row : undefined
        }),
        "trigger never disarmed as failed",
      )
      expect(failed.consecutiveFailures).toBeGreaterThanOrEqual(5)
    }),
  30_000,
)

schedulerIt.effect(
  "expired deadline wakes as timed out without running the check",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_sched_timeout")
      const scheduler = yield* SessionSleepScheduler.Service
      const trigger = yield* arm("ses_sched_timeout", { timeoutMs: 0 })

      yield* scheduler.flush()

      const timedOut = yield* pollWithTimeout(
        Effect.gen(function* () {
          const row = yield* SessionSleep.byID(db, trigger.id)
          return row?.status === "timed_out" ? row : undefined
        }),
        "trigger never timed out",
      )
      expect(timedOut.timeFinished).toBeDefined()
    }),
  30_000,
)

schedulerIt.effect(
  "deadline sweep catches a claimed-but-never-checked trigger (loop-death limbo)",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_sched_sweep")
      const scheduler = yield* SessionSleepScheduler.Service
      const trigger = yield* arm("ses_sched_sweep", { timeoutMs: 0, intervalMs: 3_600_000 })
      // Simulate a claim whose check never completes (wedged loop): the row's
      // next check moves past the deadline, so it is never due again — the
      // production limbo. The sweep must still convert it to a timeout wake.
      expect(yield* SessionSleep.claimCheck(db, trigger.id, Date.now())).toBe(true)
      const claimed = yield* SessionSleep.byID(db, trigger.id)
      expect(claimed && claimed.nextCheckAt > Date.now()).toBe(true)

      yield* scheduler.flush()

      const timedOut = yield* SessionSleep.byID(db, trigger.id)
      expect(timedOut?.status).toBe("timed_out")
    }),
  30_000,
)

// ---------------------------------------------------------------------------
// Loop liveness
// ---------------------------------------------------------------------------

/**
 * A poisoned Database whose next `update` access throws, simulating a
 * transient sqlite failure inside a scheduler tick. `Database.node` carries no
 * dependencies, so the real implementation is built inline underneath.
 */
const trip = { current: false }
const flakyDatabase = Layer.effect(
  Database.Service,
  Effect.gen(function* () {
    const real = yield* Database.Service
    const db = new Proxy(real.db, {
      get(target, prop, receiver) {
        if (trip.current && prop === "update") {
          trip.current = false
          throw new Error("simulated sqlite busy")
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    return { db }
  }),
  // Provided as a layer dependency (not built inside the effect) so the real
  // database stays open for the flaky layer's whole lifetime.
).pipe(Layer.provide(Database.node.implementation as Layer.Layer<Database.Service, never>))

const loopIt = testEffect(
  LayerNode.compile(LayerNode.group([SessionSleepScheduler.node, Database.node]), [
    [Database.node, flakyDatabase],
  ] as const),
)

// Runs against the real forked tick loop (live clock): the first tick dies on
// the poisoned db, and the loop must survive it and drain the row anyway.
loopIt.live(
  "a failed tick does not kill the scheduler loop",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_sched_loop")
      const scheduler = yield* SessionSleepScheduler.Service
      const trigger = yield* arm("ses_sched_loop", { condition: "exit 0", intervalMs: 1 })
      trip.current = true

      const fired = yield* pollWithTimeout(
        Effect.gen(function* () {
          const row = yield* SessionSleep.byID(db, trigger.id)
          return row?.status === "fired" ? row : undefined
        }),
        "trigger never fired after a broken tick",
        "30 seconds",
      )
      expect(fired.status).toBe("fired")
    }),
  60_000,
)

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

const makeDelivery = () => {
  const prompts: SessionPrompt.PromptInput[] = []
  const statuses: Array<{ sessionID: SessionID; status: SessionStatus.Info }> = []
  const fail = { current: false }

  const prompt = Layer.mock(SessionPrompt.Service, {
    prompt: (input: SessionPrompt.PromptInput) =>
      fail.current
        ? Effect.fail(new Error("simulated prompt failure") as never)
        : Effect.sync(() => {
            prompts.push(input)
            return fakeWithParts(input.sessionID)
          }),
  })
  const instances = Layer.mock(InstanceStore.Service, {
    provide: <A, E, R>(_input: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) => effect,
  })
  const status = Layer.mock(SessionStatus.Service, {
    set: (sessionID: SessionID, info: SessionStatus.Info) =>
      Effect.sync(() => {
        statuses.push({ sessionID, status: info })
      }),
  })

  const layer = LayerNode.compile(
    LayerNode.group([SessionSleepDelivery.node, Database.node]),
    [
      [InstanceStore.node, instances],
      [SessionPrompt.node, prompt],
      [SessionStatus.node, status],
    ] as const,
  )
  const it = testEffect(layer)
  return { it, prompts, statuses, fail }
}

const delivery = makeDelivery()

const finishPending = (sessionID: string, condition: string, output?: string) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const trigger = yield* SessionSleep.arm(db, {
      id: SessionSleep.ID.ascending(),
      sessionID: SessionID.make(sessionID),
      condition,
      description: "forum reply appears",
      intervalMs: 60_000,
      checkTimeoutMs: 30_000,
      deadline: Date.now() + 3_600_000,
      cwd: "/tmp/test",
      nextCheckAt: Date.now(),
    })
    yield* SessionSleep.finish(db, trigger.id, "fired", MessageID.make(`msg_sleep_${trigger.id}`), output)
    return trigger
  })

delivery.it.effect(
  "delivers a fired wake as a prompt and confirms the row",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = SessionID.make("ses_deliver_ok")
      yield* insertSession(db, "ses_deliver_ok")
      const trigger = yield* finishPending("ses_deliver_ok", "exit 0", "new reply from alice")

      const deliverySvc = yield* SessionSleepDelivery.Service
      yield* deliverySvc.flush()

      const forSession = delivery.prompts.filter((input) => input.sessionID === sessionID)
      expect(forSession).toHaveLength(1)
      expect(forSession[0]?.parts[0]).toMatchObject({ type: "text" })
      const text = (forSession[0]?.parts[0] as { text: string }).text
      expect(text).toContain("Sleep trigger fired: forum reply appears")
      expect(text).toContain("new reply from alice")

      yield* pollWithTimeout(
        Effect.gen(function* () {
          const rows = yield* SessionSleep.deliverable(db)
          return rows.some((candidate) => candidate.id === trigger.id) ? undefined : (true as const)
        }),
        "wake row never confirmed",
      )

      // A second flush does not re-deliver the confirmed row.
      const count = forSession.length
      yield* deliverySvc.flush()
      expect(delivery.prompts.filter((input) => input.sessionID === sessionID)).toHaveLength(count)
    }),
  30_000,
)

delivery.it.effect(
  "failed delivery releases the claim, resets status, and retries",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = SessionID.make("ses_deliver_retry")
      yield* insertSession(db, "ses_deliver_retry")
      const trigger = yield* finishPending("ses_deliver_retry", "exit 0", "payload")

      delivery.fail.current = true
      const deliverySvc = yield* SessionSleepDelivery.Service
      yield* deliverySvc.flush()
      expect(delivery.prompts.filter((input) => input.sessionID === sessionID)).toHaveLength(0)
      expect(delivery.statuses.some((entry) => entry.sessionID === sessionID && entry.status.type === "idle")).toBe(
        true,
      )
      const stillDue = yield* SessionSleep.deliverable(db)
      expect(stillDue.map((row) => row.id)).toContain(trigger.id)

      delivery.fail.current = false
      yield* deliverySvc.flush()
      expect(delivery.prompts.filter((input) => input.sessionID === sessionID)).toHaveLength(1)
    }),
  30_000,
)

delivery.it.effect(
  "delivery gives up after exhausting the attempt budget",
  () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const sessionID = SessionID.make("ses_deliver_budget")
      yield* insertSession(db, "ses_deliver_budget")
      const trigger = yield* finishPending("ses_deliver_budget", "exit 0", "payload")

      delivery.fail.current = true
      const deliverySvc = yield* SessionSleepDelivery.Service
      for (let i = 0; i < SessionSleep.MAX_DELIVER_ATTEMPTS; i++) yield* deliverySvc.flush()

      // Budget exhausted: the row is abandoned (confirmed) and no more prompts run.
      const before = yield* SessionSleep.deliverable(db)
      expect(before.map((row) => row.id)).not.toContain(trigger.id)
      yield* deliverySvc.flush()
      expect(delivery.prompts.filter((input) => input.sessionID === sessionID)).toHaveLength(0)
    }),
  30_000,
)

// ---------------------------------------------------------------------------
// Wake text
// ---------------------------------------------------------------------------

const row = (status: SessionSleep.Status, output = "") =>
  ({
    id: SessionSleep.ID.make("slp_test"),
    sessionID: SessionSchema.ID.make("ses_x"),
    condition: "exit 0",
    description: "forum reply appears",
    intervalMs: 60_000,
    checkTimeoutMs: 30_000,
    deadline: Date.now(),
    cwd: "/tmp",
    nextCheckAt: Date.now(),
    consecutiveFailures: 0,
    status,
    deliverAttempts: 0,
    timeCreated: Date.now(),
    ...(output ? { lastOutput: output } : {}),
  }) as SessionSleep.Trigger

test("wake text covers fired, timed out, and failed outcomes", () => {
  const fired = wakeText(row("fired", "hello world"), "hello world")
  expect(fired).toContain("Sleep trigger fired: forum reply appears")
  expect(fired).toContain("hello world")

  const timedOut = wakeText(row("timed_out"), "")
  expect(timedOut).toContain("timed out")

  const failed = wakeText(row("failed"), "boom")
  expect(failed).toContain("disarmed itself")
  expect(failed).toContain("boom")
})

// ---------------------------------------------------------------------------
// Arm-time condition validation
// ---------------------------------------------------------------------------

test("conditionSelfMatch refuses pgrep -f patterns that match their own wrapper shell", () => {
  // The production bug: pgrep -f matches the sh -c / ssh wrapper carrying the
  // whole condition text, so the check always reports the unmet state.
  expect(
    conditionSelfMatch(
      `ssh devshop 'if ! sudo pgrep -f "dpkg-buildpackage" >/dev/null; then echo BUILD_DONE; exit 0; fi; echo RUNNING; exit 1'`,
    ),
  ).toContain("own wrapper shell")
  expect(conditionSelfMatch(`pgrep -f dpkg-buildpackage >/dev/null && exit 1; echo running; exit 1`)).toContain(
    "own wrapper shell",
  )
  expect(conditionSelfMatch(`pkill -f 'my-worker' --signal 0; exit 1`)).toContain("own wrapper shell")

  // Non-full-match pgrep only sees process names; the wrapper's comm is sh/bash.
  expect(conditionSelfMatch(`pgrep dpkg-buildpackage >/dev/null || exit 1`)).toBeUndefined()
  expect(conditionSelfMatch(`pgrep -x dpkg-buildpackage >/dev/null || exit 1`)).toBeUndefined()
  // Bracket trick: the regex no longer matches the condition text itself.
  expect(
    conditionSelfMatch(`pgrep -f "[d]pkg-buildpackage" >/dev/null || { echo running; exit 1; }; echo done`),
  ).toBeUndefined()
  // No pgrep at all.
  expect(conditionSelfMatch(`test -f /tmp/done || { echo waiting; exit 1; }`)).toBeUndefined()
})

test("observeProblem only breaks on a missing state document", () => {
  // The observe's exit code is meaningless — `grep -q pattern file` legitimately
  // exits 1 while printing the state is what matters.
  expect(SessionSleepScheduler.observeProblem({ exitCode: 1, output: "state-abc", timedOut: false })).toBeUndefined()
  expect(SessionSleepScheduler.observeProblem({ exitCode: 7, output: "odd but present", timedOut: false })).toBeUndefined()
  expect(SessionSleepScheduler.observeProblem({ exitCode: 127, output: "", timedOut: false })).toContain(
    "command not found",
  )
  expect(
    SessionSleepScheduler.observeProblem({ exitCode: undefined, output: "check timed out", timedOut: true }),
  ).toContain("timed out")
  expect(SessionSleepScheduler.observeProblem({ exitCode: undefined, output: "spawn failed", timedOut: false })).toBe(
    "spawn failed",
  )
})

test("conditionClock flags time literals in predicates", () => {
  expect(conditionClock(`awk '$1 > "15:29" || { echo waiting; exit 1; }'`)).toContain("clock time")
  expect(conditionClock(`grep -q '2026-10-28 done' || { echo waiting; exit 1; }`)).toContain("calendar date")
  expect(conditionClock(`test "$(date +%s)" -gt 1790000000`)).toContain("$(date")
  // A date *regex* matches a timestamp field of the state — a value, not a
  // window — so it is deliberately not flagged.
  expect(conditionClock(`grep -qE '^\\d{4}-\\d{2}-\\d{2}' || { echo waiting; exit 1; }`)).toBeUndefined()
  expect(conditionClock(predicateDone)).toBeUndefined()
})

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

// The tool wrapper ends with Effect.orDie, so the model-facing error lives in
// the exit cause as a defect.
const toolDieMessage = (exit: Exit.Exit<unknown>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (!Exit.isFailure(exit)) return ""
  const die = exit.cause.reasons.find(Cause.isDieReason)
  return (die?.defect as Error)?.message ?? String(die?.defect)
}

const toolIt = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Config.node,
      SessionStatus.node,
      SessionSleepScheduler.node,
      InstanceStore.node,
      Database.node,
      Truncate.node,
      Agent.node,
    ]),
    [[InstanceStore.bootstrapNode, noopBootstrap]],
  ),
)

toolIt.instance(
  "sleep_until probes, arms, replaces; sleep_cancel disarms",
  () =>
    Effect.gen(function* () {
      yield* TestInstance
      const sessionID = SessionID.make("ses_tool")
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_tool")
      const scheduler = yield* SessionSleepScheduler.Service
      const asks: unknown[] = []
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_tool"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (req) => Effect.sync(() => asks.push(req)),
      }

      const until = yield* SleepUntilTool
      const untilDef = yield* until.init()

      // Condition already met: no sleep armed, permission still asked.
      const met = yield* untilDef.execute(
        { observe: "echo state-a", predicate: "exit 0", met_example: "", description: "instant" },
        ctx,
      )
      expect(met.output).toContain("already satisfies the predicate")
      expect(asks).toHaveLength(1)
      expect(yield* scheduler.get(sessionID)).toBeUndefined()

      // Live state unmet plus a met_example the predicate accepts: arms a
      // pending trigger.
      const armed = yield* untilDef.execute({ ...stateCheck, description: "forum reply" }, ctx)
      expect(armed.output).toContain("Sleep armed")
      expect(armed.output).toContain("proven at arm time")
      const first = yield* scheduler.get(sessionID)
      expect(first?.status).toBe("pending")
      expect(first?.description).toBe("forum reply")
      expect(first?.observe).toBe(observeState)
      expect(first?.predicate).toBe(predicateDone)
      expect(first?.metExample).toBe(metExample)

      // Re-arming replaces the previous trigger.
      yield* untilDef.execute({ ...stateCheck, description: "second wait" }, ctx)
      const second = yield* scheduler.get(sessionID)
      expect(second?.id).not.toBe(first?.id)
      expect(second?.description).toBe("second wait")
      const refreshedFirst = yield* SessionSleep.byID(db, first!.id)
      expect(refreshedFirst?.status).toBe("cancelled")

      // sleep_status peeks at the armed trigger, including recorded check output.
      const statusTool = yield* SleepStatusTool
      const statusDef = yield* statusTool.init()
      yield* SessionSleep.recordNotMet(db, second!.id, "21/27 images")
      const peek = yield* statusDef.execute({}, ctx)
      expect(peek.output).toContain("pending")
      expect(peek.output).toContain("second wait")
      expect(peek.output).toContain("21/27 images")
      const peekEmpty = yield* statusDef.execute(
        {},
        { ...ctx, sessionID: SessionID.make("ses_tool_none") },
      )
      expect(peekEmpty.output).toContain("No sleep trigger")

      // Cancel disarms.
      const cancel = yield* SleepCancelTool
      const cancelDef = yield* cancel.init()
      const cancelled = yield* cancelDef.execute({}, ctx)
      expect(cancelled.output).toContain("cancelled")
      expect((yield* scheduler.get(sessionID))?.status).toBe("cancelled")

      // Cancelling again reports nothing to cancel.
      const noop = yield* cancelDef.execute({}, ctx)
      expect(noop.output).toContain("No armed sleep trigger")
    }),
  30_000,
)

toolIt.instance(
  "sleep_until refuses to arm when the observe is broken",
  () =>
    Effect.gen(function* () {
      yield* TestInstance
      const sessionID = SessionID.make("ses_tool_obs_broken")
      const db = (yield* Database.Service).db
      yield* insertSession(db, sessionID)
      const scheduler = yield* SessionSleepScheduler.Service
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_tool_obs_broken"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const until = yield* SleepUntilTool
      const untilDef = yield* until.init()

      // A missing command cannot print the state document: on Windows cmd.exe
      // reports it with exit code 1, so the detection cannot rely on the code
      // alone.
      const refused = yield* untilDef
        .execute(
          { observe: "opencode-sleep-missing-cmd", predicate: predicateDone, met_example: metExample, description: "broken" },
          ctx,
        )
        .pipe(Effect.exit)
      expect(toolDieMessage(refused)).toContain("refused to arm")
      expect(toolDieMessage(refused)).toContain("observe is broken")
      expect(yield* scheduler.get(sessionID)).toBeUndefined()
      expect(yield* SessionSleep.get(db, sessionID)).toBeUndefined()
    }),
  30_000,
)

toolIt.instance(
  "sleep_until refuses to arm when the predicate is broken on the live state",
  () =>
    Effect.gen(function* () {
      yield* TestInstance
      const sessionID = SessionID.make("ses_tool_broken")
      const db = (yield* Database.Service).db
      yield* insertSession(db, sessionID)
      const scheduler = yield* SessionSleepScheduler.Service
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_tool_broken"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const until = yield* SleepUntilTool
      const untilDef = yield* until.init()

      // Non-zero, non-1 exit code from the predicate: broken contract, nothing armed.
      const exit7 = yield* untilDef
        .execute({ observe: observeState, predicate: "exit 7", met_example: "", description: "broken" }, ctx)
        .pipe(Effect.exit)
      expect(toolDieMessage(exit7)).toContain("refused to arm")
      expect(toolDieMessage(exit7)).toContain("predicate is broken")
      expect(toolDieMessage(exit7)).toContain("exit code 7")
      expect(yield* scheduler.get(sessionID)).toBeUndefined()
    }),
  30_000,
)

toolIt.instance(
  "sleep_until refuses to arm a silent unmet condition",
  () =>
    Effect.gen(function* () {
      yield* TestInstance
      const sessionID = SessionID.make("ses_tool_silent")
      const db = (yield* Database.Service).db
      yield* insertSession(db, sessionID)
      const scheduler = yield* SessionSleepScheduler.Service
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_tool_silent"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const until = yield* SleepUntilTool
      const untilDef = yield* until.init()

      // exit 1 with no output cannot prove the predicate is alive, so arming
      // is refused instead of sleeping to the timeout on a dead check.
      const silent = yield* untilDef
        .execute({ observe: observeState, predicate: "exit 1", met_example: "", description: "silent" }, ctx)
        .pipe(Effect.exit)
      const message = toolDieMessage(silent)
      expect(message).toContain("refused to arm")
      expect(message).toContain("silent check")
      expect(message).toContain("echo")
      expect(yield* scheduler.get(sessionID)).toBeUndefined()
      expect(yield* SessionSleep.get(db, sessionID)).toBeUndefined()

      // The same predicate with progress output and a matching met_example arms fine.
      const armed = yield* untilDef.execute({ ...stateCheck, description: "loud" }, ctx)
      expect(armed.output).toContain("Sleep armed")
      expect((yield* scheduler.get(sessionID))?.status).toBe("pending")
    }),
  30_000,
)

toolIt.instance(
  "sleep_until refuses to arm a condition that matches its own wrapper shell",
  () =>
    Effect.gen(function* () {
      yield* TestInstance
      const sessionID = SessionID.make("ses_tool_selfmatch")
      const db = (yield* Database.Service).db
      yield* insertSession(db, sessionID)
      const scheduler = yield* SessionSleepScheduler.Service
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_tool_selfmatch"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const until = yield* SleepUntilTool
      const untilDef = yield* until.init()

      // The pgrep pattern appears in the predicate text, so the check would
      // always find its own sh -c / ssh wrapper and never report the waited
      // -for state. Refused before arming (and before the permission ask).
      const predicate = `pgrep -f dpkg-buildpackage >/dev/null || { echo running; exit 1; }; echo done`
      const refused = yield* untilDef
        .execute({ observe: observeState, predicate, met_example: "", description: "build watch" }, ctx)
        .pipe(Effect.exit)
      expect(toolDieMessage(refused)).toContain("refused to arm")
      expect(toolDieMessage(refused)).toContain("own wrapper shell")
      expect(yield* scheduler.get(sessionID)).toBeUndefined()
      expect(yield* SessionSleep.get(db, sessionID)).toBeUndefined()
    }),
  30_000,
)

toolIt.instance(
  "sleep_until stops re-arming after consecutive timeouts",
  () =>
    Effect.gen(function* () {
      yield* TestInstance
      const sessionID = SessionID.make("ses_tool_budget")
      const db = (yield* Database.Service).db
      yield* insertSession(db, sessionID)
      const scheduler = yield* SessionSleepScheduler.Service
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_tool_budget"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const until = yield* SleepUntilTool
      const untilDef = yield* until.init()

      // Three triggers in a row that end without ever being met: the exact
      // "pod never came up, re-arm, timeout, re-arm" loop that burns billed
      // turns. The fourth arm must be refused.
      for (let i = 0; i < 3; i++) {
        const armed = yield* untilDef.execute({ ...stateCheck, description: `wait ${i}` }, ctx)
        expect(armed.output).toContain("Sleep armed")
        const trigger = yield* scheduler.get(sessionID)
        yield* SessionSleep.finish(db, trigger!.id, "timed_out", SessionSleep.wakeMessageID(trigger!))
      }

      const refused = yield* untilDef.execute({ ...stateCheck, description: "wait 4" }, ctx).pipe(Effect.exit)
      const message = toolDieMessage(refused)
      expect(message).toContain("refused to arm")
      expect(message).toContain("cost guard")

      // A met trigger breaks the streak: the budget only caps timeout loops,
      // not sessions that get their wake and continue.
      const fresh = yield* SessionSleep.arm(db, {
        id: SessionSleep.ID.ascending(),
        sessionID,
        condition: unmetWithOutput,
        description: "met before",
        intervalMs: 60_000,
        checkTimeoutMs: 30_000,
        deadline: Date.now() + 3_600_000,
        cwd: "/tmp/test",
        nextCheckAt: Date.now(),
      })
      yield* SessionSleep.finish(db, fresh.id, "fired", SessionSleep.wakeMessageID(fresh))
      const recovered = yield* untilDef.execute({ ...stateCheck, description: "fresh wait" }, ctx)
      expect(recovered.output).toContain("Sleep armed")
    }),
  30_000,
)

toolIt.instance(
  "sleep_until refuses to arm when the met_example fails the predicate",
  () =>
    Effect.gen(function* () {
      yield* TestInstance
      const sessionID = SessionID.make("ses_tool_example")
      const db = (yield* Database.Service).db
      yield* insertSession(db, sessionID)
      const scheduler = yield* SessionSleepScheduler.Service
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_tool_example"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const until = yield* SleepUntilTool
      const untilDef = yield* until.init()

      // The predicate ignores stdin entirely and always reports "not met": it
      // is the exact class of never-firing check the arm gate must reject.
      // The fabricated positive is the only thing that can tell.
      const predicate = process.platform === "win32" ? "echo not yet & exit 1" : "echo 'not yet'; exit 1"
      const refused = yield* untilDef
        .execute({ observe: observeState, predicate, met_example: "state done", description: "vague" }, ctx)
        .pipe(Effect.exit)
      const message = toolDieMessage(refused)
      expect(message).toContain("refused to arm")
      expect(message).toContain("met_example does not satisfy your own predicate")
      expect(message).toContain("Predicate on live state")
      expect(message).toContain("Predicate on met_example")
      expect(yield* scheduler.get(sessionID)).toBeUndefined()
      expect(yield* SessionSleep.get(db, sessionID)).toBeUndefined()
    }),
  30_000,
)

toolIt.instance(
  "sleep_until refuses clock-window predicates unless explicitly allowed",
  () =>
    Effect.gen(function* () {
      yield* TestInstance
      const sessionID = SessionID.make("ses_tool_clock")
      yield* insertSession((yield* Database.Service).db, sessionID)
      const scheduler = yield* SessionSleepScheduler.Service
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_tool_clock"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const until = yield* SleepUntilTool
      const untilDef = yield* until.init()

      // The predicate compares against a clock literal: the exact time-window
      // trap that silently expires. Refused by default, even though the
      // met_example below would satisfy it.
      const predicate =
        process.platform === "win32"
          ? `findstr 15:29 >NUL 2>&1 || (echo waiting & exit 1)`
          : `grep -q '15:29 done' || { echo waiting; exit 1; }`
      const refused = yield* untilDef
        .execute(
          { observe: observeState, predicate, met_example: "at 15:29 it is done", description: "clock" },
          ctx,
        )
        .pipe(Effect.exit)
      expect(toolDieMessage(refused)).toContain("clock time")
      expect(toolDieMessage(refused)).toContain("allow_clock_predicate")
      expect(yield* scheduler.get(sessionID)).toBeUndefined()

      // The explicit override arms it — the escape hatch stays visible.
      const armed = yield* untilDef.execute(
        {
          observe: observeState,
          predicate,
          met_example: "at 15:29 it is done",
          allow_clock_predicate: true,
          description: "clock, allowed",
        },
        ctx,
      )
      expect(armed.output).toContain("Sleep armed")
    }),
  30_000,
)

toolIt.instance(
  "a state trigger fires when the state document changes",
  () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const sessionID = SessionID.make("ses_tool_state_fire")
      const db = (yield* Database.Service).db
      yield* insertSession(db, sessionID)
      const scheduler = yield* SessionSleepScheduler.Service
      const ctx: Tool.Context = {
        sessionID,
        messageID: MessageID.make("msg_tool_state_fire"),
        callID: "",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const until = yield* SleepUntilTool
      const untilDef = yield* until.init()

      const watch = path.join(test.directory, "watch.log")
      yield* Effect.promise(() => Bun.write(watch, "job started\n"))
      const observe = process.platform === "win32" ? `type ${watch}` : `cat ${watch}`
      const armed = yield* untilDef.execute(
        { observe, predicate: predicateDone, met_example: "job done\n", description: "job completes" },
        ctx,
      )
      expect(armed.output).toContain("Sleep armed")
      const trigger = yield* scheduler.get(sessionID)

      // State without the marker: the background check records progress and
      // leaves the trigger pending.
      yield* scheduler.flush()
      const pending = yield* SessionSleep.byID(db, trigger!.id)
      expect(pending?.status).toBe("pending")
      expect(pending?.lastOutput).toContain("[state]")
      expect(pending?.lastOutput).toContain("job started")
      expect(pending?.lastOutput).toContain("still waiting")

      // The marker appears: the wake carries the state document. The first
      // flush claimed the check and advanced next_check_at by the interval, so
      // backdate it to make the row due again.
      const claimed = yield* SessionSleep.byID(db, trigger!.id)
      yield* db
        .update(SessionSleepTable)
        .set({ next_check_at: Date.now() - 1 })
        .where(eq(SessionSleepTable.id, trigger!.id))
        .run()
        .pipe(Effect.orDie)
      expect(claimed?.lastOutput).toContain("still waiting")
      yield* Effect.promise(() => Bun.write(watch, "job started\njob done\n"))
      yield* scheduler.flush()
      const fired = yield* pollWithTimeout(
        Effect.gen(function* () {
          const row = yield* SessionSleep.byID(db, trigger!.id)
          return row?.status === "fired" ? row : undefined
        }),
        "state trigger never fired",
        "30 seconds",
      )
      expect(fired.lastOutput).toContain("[state]")
      expect(fired.lastOutput).toContain("job done")
    }),
  30_000,
)
