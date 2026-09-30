export * as SleepTool from "./sleep"

import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { SessionStatus } from "@/session/status"
import { SessionSleepScheduler } from "@/session/sleep-scheduler"

export const SleepUntilParameters = Schema.Struct({
  condition: Schema.String.annotate({
    description:
      "Shell command whose exit code decides when to wake: exit 0 = condition met, exit 1 = not met yet, anything else counts as a broken check. Keep it fast (seconds) and free of side effects. stdout from the final check is delivered to the session when it wakes. The condition is probe-run once before arming: if that run is broken (exit outside 0/1, command not found, spawn failure, or timeout), sleep_until fails instead of arming.",
  }),
  description: Schema.String.annotate({
    description: "What you are waiting for, in one sentence. Shown to the user and included in the wake message.",
  }),
  interval_seconds: PositiveInt.pipe(Schema.optional).annotate({
    description: "Seconds between checks. Default 60, minimum 15.",
  }),
  timeout_minutes: PositiveInt.pipe(Schema.optional).annotate({
    description: "Minutes before the trigger gives up and wakes the session with a timeout notice. Default 360 (6h).",
  }),
})

export const SleepCancelParameters = Schema.Struct({})

type Metadata = {
  trigger?: string
  trigger_status: string
  interval_ms?: number
  deadline?: number
  cancelled?: boolean
}

const sleepLimits = Effect.fn("SleepTool.sleepLimits")(function* (config: Config.Interface) {
  const sleep = (yield* config.get()).sleep
  return {
    intervalSeconds: sleep?.interval_seconds ?? 60,
    minIntervalSeconds: sleep?.min_interval_seconds ?? 15,
    timeoutMinutes: sleep?.timeout_minutes ?? 360,
    maxTimeoutMinutes: sleep?.max_timeout_minutes ?? 7 * 24 * 60,
    checkTimeoutMs: (sleep?.check_timeout_seconds ?? 30) * 1000,
  }
})

export const SleepUntilTool = Tool.define<
  typeof SleepUntilParameters,
  Metadata,
  SessionSleepScheduler.Service | Config.Service | SessionStatus.Service
>(
  "sleep_until",
  Effect.gen(function* () {
    const scheduler = yield* SessionSleepScheduler.Service
    const status = yield* SessionStatus.Service
    const config = yield* Config.Service

    const run = (
      params: Schema.Schema.Type<typeof SleepUntilParameters>,
      ctx: Tool.Context<Metadata>,
    ) =>
      Effect.gen(function* () {
        const limits = yield* sleepLimits(config)
        const intervalSeconds = Math.max(
          params.interval_seconds ?? limits.intervalSeconds,
          limits.minIntervalSeconds,
        )
        const timeoutMinutes = Math.min(params.timeout_minutes ?? limits.timeoutMinutes, limits.maxTimeoutMinutes)
        yield* ctx.ask({
          permission: "sleep_until",
          patterns: [params.condition],
          always: [params.condition],
          metadata: { description: params.description, command: params.condition },
        })

        const instance = yield* InstanceState.context
        const cwd = instance.worktree ?? instance.directory

        // Probe once before arming. This doubles as the correctness gate: the
        // tool refuses to arm a condition whose first execution is already
        // broken, so a bad script fails here instead of sleeping to the timeout.
        const probe = yield* scheduler.probe({
          condition: params.condition,
          cwd,
          timeoutMs: limits.checkTimeoutMs,
        })
        const probeOutput = () => {
          const text = probe.output.trim()
          return text.length > 0 ? text.slice(-2000) : undefined
        }
        const verdict = SessionSleepScheduler.classifyCheck(probe)

        if (verdict.kind === "met") {
          return {
            title: "condition already met",
            output: [
              "The condition is already met (exit 0). No sleep armed.",
              probeOutput() !== undefined ? `Check output:\n${probeOutput()}` : undefined,
            ]
              .filter(Boolean)
              .join("\n\n"),
            metadata: { trigger_status: "not_armed" },
          }
        }

        if (verdict.kind === "broken") {
          return yield* Effect.fail(
            new Error(
              [
                `sleep_until refused to arm: the probe check is broken — ${verdict.reason}.`,
                "Nothing was armed. Fix the condition so it exits 0 when met and 1 when not met yet, then call sleep_until again.",
                probeOutput() !== undefined ? `Probe output:\n${probeOutput()}` : undefined,
              ]
                .filter(Boolean)
                .join("\n\n"),
            ),
          )
        }

        const trigger = yield* scheduler.arm({
          sessionID: ctx.sessionID,
          condition: params.condition,
          description: params.description,
          intervalMs: intervalSeconds * 1000,
          timeoutMs: timeoutMinutes * 60 * 1000,
          checkTimeoutMs: limits.checkTimeoutMs,
          cwd,
        })
        yield* status.set(ctx.sessionID, {
          type: "sleeping",
          description: params.description,
          wake_at: trigger.deadline,
        })
        const deadline = new Date(trigger.deadline).toISOString()
        yield* Effect.logInfo("sleep trigger armed", {
          "session.id": ctx.sessionID,
          trigger: trigger.id,
          description: params.description,
          intervalMs: trigger.intervalMs,
          deadline,
        })
        return {
          title: `sleeping: ${params.description}`,
          output: [
            `Sleep armed (${trigger.id}). Waiting for: ${params.description}`,
            `Checks run every ${intervalSeconds}s in the background; timeout at ${deadline}.`,
            "Condition not met yet (probe exit 1).",
            probeOutput() !== undefined ? `Probe output:\n${probeOutput()}` : undefined,
            "IMPORTANT: do not busy-wait with bash sleep while this trigger is armed — end your turn, or do unrelated work.",
            "The wake arrives automatically (even mid-turn) with the final check output. Call sleep_status to peek at the latest check output without waiting.",
            "Re-arming replaces this trigger; sleep_cancel disarms it.",
          ]
            .filter(Boolean)
            .join("\n"),
          metadata: {
            trigger: trigger.id,
            trigger_status: trigger.status,
            interval_ms: trigger.intervalMs,
            deadline: trigger.deadline,
          },
        }
      })

    return {
      description: [
        "Arm a background trigger that wakes this session automatically when a condition becomes true.",
        "When armed, END YOUR TURN (or do unrelated work) — never busy-wait with sleep in bash while a trigger is armed;",
        "the wake message arrives automatically, even mid-turn. To see the latest check output, call sleep_status instead of polling.",
        "The trigger survives server restarts. Arming again replaces the previous trigger; cancel with sleep_cancel.",
        "The condition is probe-run once before arming; a broken probe (exit outside 0/1, command not found, spawn failure, or timeout) fails the call instead of arming, so fix the condition and retry.",
        "Use for external events: a forum reply appears, a payment lands, a long job finishes, a file changes.",
        "Do not use it as a short timer — to wait a few seconds inside a command, use sleep in bash instead.",
      ].join(" "),
      parameters: SleepUntilParameters,
      execute: (params: Schema.Schema.Type<typeof SleepUntilParameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof SleepUntilParameters, Metadata>
  }),
)

export const SleepStatusParameters = Schema.Struct({})

export const SleepStatusTool = Tool.define<
  typeof SleepStatusParameters,
  Metadata,
  SessionSleepScheduler.Service
>(
  "sleep_status",
  Effect.gen(function* () {
    const scheduler = yield* SessionSleepScheduler.Service

    return {
      description: [
        "Peek at this session's sleep_until trigger without waiting: armed status, next check time, and the output of the most recent condition check.",
        "Use it for progress while a trigger is armed (make your condition print progress on exit 1) instead of blocking on bash sleep.",
      ].join(" "),
      parameters: SleepStatusParameters,
      execute: (_params: Schema.Schema.Type<typeof SleepStatusParameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const trigger = yield* scheduler.get(ctx.sessionID)
          if (!trigger) {
            return {
              title: "no trigger",
              output: "No sleep trigger was ever armed for this session.",
              metadata: { trigger_status: "none" },
            }
          }
          const lines = [
            `Trigger ${trigger.id}: ${trigger.status}`,
            `Waiting for: ${trigger.description}`,
            `Checks every ${Math.round(trigger.intervalMs / 1000)}s; next check ${new Date(trigger.nextCheckAt).toISOString()}; timeout ${new Date(trigger.deadline).toISOString()}`,
            trigger.consecutiveFailures > 0 ? `Consecutive check failures: ${trigger.consecutiveFailures}` : undefined,
            trigger.lastOutput ? `Last check output:\n${trigger.lastOutput}` : "No check output recorded yet.",
            trigger.status === "pending"
              ? "Still armed — end your turn or call sleep_cancel; the wake arrives automatically."
              : "The trigger is finished; its wake (if any) was delivered.",
          ].filter(Boolean)
          return {
            title: `trigger ${trigger.status}`,
            output: lines.join("\n"),
            metadata: {
              trigger: trigger.id,
              trigger_status: trigger.status,
              interval_ms: trigger.intervalMs,
              deadline: trigger.deadline,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof SleepStatusParameters, Metadata>
  }),
)

export const SleepCancelTool = Tool.define<
  typeof SleepCancelParameters,
  Metadata,
  SessionSleepScheduler.Service | SessionStatus.Service
>(
  "sleep_cancel",
  Effect.gen(function* () {
    const scheduler = yield* SessionSleepScheduler.Service
    const status = yield* SessionStatus.Service

    return {
      description:
        "Cancel this session's armed sleep_until trigger. Use when the wait is no longer needed. Arming a new trigger with sleep_until also replaces the old one.",
      parameters: SleepCancelParameters,
      execute: (_params: Schema.Schema.Type<typeof SleepCancelParameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const cancelled = yield* scheduler.cancel(ctx.sessionID)
          if (!cancelled) {
            const latest = yield* scheduler.get(ctx.sessionID)
            return {
              title: "nothing to cancel",
              output: latest
                ? `No armed sleep trigger. The most recent trigger (${latest.id}) is already ${latest.status}.`
                : "No sleep trigger was ever armed for this session.",
              metadata: { trigger_status: latest?.status ?? "none" },
            }
          }
          yield* status.set(ctx.sessionID, { type: "idle" })
          yield* Effect.logInfo("sleep trigger cancelled", { "session.id": ctx.sessionID })
          return {
            title: "sleep cancelled",
            output: "Sleep trigger cancelled. No wake will be delivered.",
            metadata: { trigger_status: "cancelled", cancelled: true },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof SleepCancelParameters, Metadata>
  }),
)
