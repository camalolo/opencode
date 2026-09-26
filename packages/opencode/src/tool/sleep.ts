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
      "Shell command whose exit code decides when to wake: exit 0 = condition met, exit 1 = not met yet, anything else counts as a broken check. Keep it fast (seconds) and free of side effects. stdout from the final check is delivered to the session when it wakes.",
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

    return {
      description: [
        "Arm a background trigger that wakes this session automatically when a condition becomes true.",
        "The session can end its turn while the trigger polls in the background;",
        "when the condition is met the session receives a new message containing the final check output.",
        "The trigger survives server restarts. Arming again replaces the previous trigger; cancel with sleep_cancel.",
        "Use for external events: a forum reply appears, a payment lands, a long job finishes, a file changes.",
        "Do not use it as a short timer — to wait a few seconds inside a command, use sleep in bash instead.",
      ].join(" "),
      parameters: SleepUntilParameters,
      execute: (params: Schema.Schema.Type<typeof SleepUntilParameters>, ctx: Tool.Context<Metadata>) =>
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

          // Probe once before arming: if the condition already holds, the LLM
          // learns immediately instead of waiting for a wake round-trip.
          const probe = yield* scheduler.probe({ condition: params.condition, cwd })
          if (probe.exitCode === 0) {
            return {
              title: "condition already met",
              output: [
                "The condition is already met (exit 0). No sleep armed.",
                probe.output.trim().length > 0 ? `Check output:\n${probe.output}` : undefined,
              ]
                .filter(Boolean)
                .join("\n\n"),
              metadata: { trigger_status: "not_armed" },
            }
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
              probe.timedOut
                ? "Note: the probe check timed out; if this repeats the trigger will disarm itself and report."
                : probe.exitCode === undefined || probe.exitCode < 0
                  ? "Note: the probe check did not exit cleanly; repeated failures will disarm the trigger and wake you with the error."
                  : "Condition not met yet (exit 1).",
              "When the condition is met you will receive a message with the final check output and can continue. The trigger survives restarts.",
              "Re-arming replaces this trigger; sleep_cancel disarms it.",
            ].join("\n"),
            metadata: {
              trigger: trigger.id,
              trigger_status: trigger.status,
              interval_ms: trigger.intervalMs,
              deadline: trigger.deadline,
            },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof SleepUntilParameters, Metadata>
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
