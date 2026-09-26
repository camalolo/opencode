import { Database } from "@opencode-ai/core/database/database"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSleep } from "@opencode-ai/core/session/sleep"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { expect, test } from "bun:test"
import { Effect, Layer } from "effect"
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
import { SleepCancelTool, SleepUntilTool } from "@/tool/sleep"
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

      const unmet = yield* arm("ses_sched_fire", { condition: "exit 1", description: "unmet" })
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
// Tools
// ---------------------------------------------------------------------------

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))

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
      const met = yield* untilDef.execute({ condition: "exit 0", description: "instant" }, ctx)
      expect(met.output).toContain("already met")
      expect(asks).toHaveLength(1)
      expect(yield* scheduler.get(sessionID)).toBeUndefined()

      // Condition unmet: arms a pending trigger.
      const armed = yield* untilDef.execute({ condition: "exit 1", description: "forum reply" }, ctx)
      expect(armed.output).toContain("Sleep armed")
      const first = yield* scheduler.get(sessionID)
      expect(first?.status).toBe("pending")
      expect(first?.description).toBe("forum reply")

      // Re-arming replaces the previous trigger.
      yield* untilDef.execute({ condition: "exit 1", description: "second wait" }, ctx)
      const second = yield* scheduler.get(sessionID)
      expect(second?.id).not.toBe(first?.id)
      expect(second?.description).toBe("second wait")
      const refreshedFirst = yield* SessionSleep.byID(db, first!.id)
      expect(refreshedFirst?.status).toBe("cancelled")

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
)
