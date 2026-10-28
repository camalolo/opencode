export * as SleepTool from "./sleep"

import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Database } from "@opencode-ai/core/database/database"
import { MAX_BROKEN_CHECKS, SessionSleep } from "@opencode-ai/core/session/sleep"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { SessionStatus } from "@/session/status"
import { SessionSleepScheduler } from "@/session/sleep-scheduler"

export const SleepUntilParameters = Schema.Struct({
  observe: Schema.String.annotate({
    description:
      "Shell command that prints the current state to stdout (the state document) — e.g. `tail -n 50 /var/log/build.log`, `pgrep -f '[b]uild.sh' || true`, `curl -s -o /dev/null -w '%{http_code}' https://example.com`. Runs at every check; stdout is piped into `predicate` and becomes your progress output and wake payload. Its exit code is ignored (only timeouts and missing commands count as broken). Keep it fast and free of side effects.",
  }),
  predicate: Schema.String.annotate({
    description:
      "Shell code that reads the state document on stdin and decides: exit 0 = met, exit 1 = unmet (print a progress line — a silent exit 1 counts as broken), anything else = broken. It must judge the stdin it is given: sleep_until proves at arm time that the predicate exits 0 on `met_example` and 1 on the live state, so a predicate that ignores stdin and reads the world itself cannot be armed.",
  }),
  met_example: Schema.String.annotate({
    description:
      "Literal state document that means done — your fabricated positive. Verified at arm time: sleep_until refuses to arm unless your own predicate exits 0 on this text. If you cannot write it, you cannot detect the state — refine observe/predicate instead. Empty string is valid when the state document is empty at completion (e.g. a process-exit watch).",
  }),
  allow_clock_predicate: Schema.Boolean.pipe(Schema.optional).annotate({
    description:
      "Set true only when the predicate genuinely needs clock arithmetic (e.g. file mtime age). By default sleep_until refuses predicates containing time literals (clock times, dates, $(date …)) because they usually encode a window that silently expires — rewrite the check as a state comparison instead.",
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
    maxConsecutiveTimeouts: sleep?.max_consecutive_timeouts ?? 3,
  }
})

/**
 * Detects conditions that are guaranteed to match their own wrapper shell in
 * the process list. The scheduler runs the condition through
 * `sh -c '<condition>'` (ssh adds another shell carrying the same text), so
 * while the check runs, the full condition text is some process's command
 * line. A `pgrep -f <pattern>` whose pattern regex-matches the condition
 * string therefore always finds that wrapper and reports the unmet state
 * forever — regardless of what is actually running. This exact bug was
 * observed in production: builds finished but the watch kept saying RUNNING
 * until its timeout. Returns the refusal reason, or undefined when clean.
 */
export const conditionSelfMatch = (condition: string): string | undefined => {
  for (const match of condition.matchAll(/\b(?:pgrep|pkill)\b/g)) {
    let index = match.index! + match[0].length
    let fullMatch = false
    let pattern: string | undefined
    scan: while (index < condition.length) {
      const rest = condition.slice(index)
      const skipped = rest.match(/^\s+/)?.[0].length ?? 0
      if (skipped > 0) {
        index += skipped
        continue
      }
      const char = condition[index]
      // End of this command: the flags/pattern scan must not run into the next one.
      if (char === undefined || char === ";" || char === "|" || char === "&" || char === ")") break
      if (char === "-") {
        const flag = rest.match(/^--?[a-zA-Z-]+/)?.[0]
        if (!flag) break
        if (flag.startsWith("--")) {
          if (flag === "--full" || flag === "--list-full") fullMatch = true
          if (flag === "--exact") fullMatch = false
        } else {
          if (flag.slice(1).includes("f")) fullMatch = true
          if (flag.slice(1).includes("x")) fullMatch = false
        }
        index += flag.length
        continue
      }
      if (char === "'" || char === '"') {
        const end = condition.indexOf(char, index + 1)
        if (end === -1) break
        pattern = condition.slice(index + 1, end)
      } else {
        pattern = rest.match(/^[^\s;|&)]+/)?.[0]
      }
      break scan
    }
    if (!fullMatch || pattern === undefined) continue
    let hitsSelf: boolean
    try {
      hitsSelf = new RegExp(pattern).test(condition)
    } catch {
      // Not a valid regex; pgrep would treat it literally. Nothing to prove here.
      continue
    }
    if (!hitsSelf) continue
    return [
      `the condition uses \`${match[0]} -f ${pattern}\`, but the pattern also matches the condition's own wrapper shell:`,
      "while the check runs, the entire condition text is a process command line (sh -c / ssh), so the check always finds itself and can never report the waited-for state.",
      "Fix it so the wrapper cannot match: bracket the first character in the pgrep argument (e.g. pgrep -f \"[d]pkg-buildpackage\") AND make sure the spelled-out word appears nowhere else in the condition, or better, match a pidfile or a marker the workload writes on completion.",
    ].join(" ")
  }
  return undefined
}

/**
 * Detects predicates that encode a point in time rather than a property of the
 * observed state. A time-window predicate stays "not met" forever once the
 * window passes while looking perfectly healthy — the observed failure mode
 * behind most stuck sleeps. Refusal (not a warning) keeps the arm gate binary:
 * the rewrite is a state comparison, or an explicit `allow_clock_predicate`
 * override that stays visible in the tool call. Returns what tripped, or
 * undefined when clean.
 */
export const conditionClock = (predicate: string): string | undefined => {
  const patterns: readonly (readonly [RegExp, string])[] = [
    [/\b\d{1,2}:\d{2}\b/, "a clock time (e.g. 15:29)"],
    [/\b\d{4}-\d{2}-\d{2}\b/, "a calendar date"],
    [/\$\(\s*date[\s+]/, "a $(date …) substitution"],
    [/\bdate\s+\+/, "date formatting"],
  ]
  for (const [pattern, what] of patterns) if (pattern.test(predicate)) return what
  return undefined
}

export const SleepUntilTool = Tool.define<
  typeof SleepUntilParameters,
  Metadata,
  SessionSleepScheduler.Service | Config.Service | SessionStatus.Service | Database.Service
>(
  "sleep_until",
  Effect.gen(function* () {
    const scheduler = yield* SessionSleepScheduler.Service
    const status = yield* SessionStatus.Service
    const config = yield* Config.Service
    const db = (yield* Database.Service).db

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

        for (const [name, text] of [
          ["observe", params.observe],
          ["predicate", params.predicate],
        ] as const) {
          const selfMatch = conditionSelfMatch(text)
          if (selfMatch)
            return yield* Effect.fail(
              new Error(
                [
                  `sleep_until refused to arm: the ${name} can never become true —`,
                  selfMatch,
                ].join(" "),
              ),
            )
        }

        if (params.allow_clock_predicate !== true) {
          const clock = conditionClock(params.predicate)
          if (clock)
            return yield* Effect.fail(
              new Error(
                [
                  `sleep_until refused to arm: the predicate contains ${clock}.`,
                  "Time-window predicates silently expire — once the window passes, the check stays not-met forever while looking healthy.",
                  "Rewrite the predicate as a state comparison over the state document (what is true when done that is false now?),",
                  "or pass allow_clock_predicate: true if the clock arithmetic is genuinely the wait (e.g. file mtime age).",
                ].join(" "),
              ),
            )
        }

        // Re-arm budget: a session whose recent triggers all timed out or
        // broke is polling for something that never happens, and every
        // timeout wake is a billed turn. Cut the loop and force a report to
        // the user instead of letting the charges accrue silently.
        const recent = yield* SessionSleep.history(db, ctx.sessionID)
        let consecutiveTimeouts = 0
        for (const row of recent) {
          if (row.status !== "timed_out" && row.status !== "failed") break
          consecutiveTimeouts += 1
        }
        if (consecutiveTimeouts >= limits.maxConsecutiveTimeouts)
          return yield* Effect.fail(
            new Error(
              [
                `sleep_until refused to arm: the last ${consecutiveTimeouts} triggers on this session ended in timeout or failure without the condition ever being met.`,
                "This is a cost guard — repeatedly re-arming a never-true condition burns a billed turn on every timeout.",
                "Do not call sleep_until again. Tell the user the wait is not converging, summarize what was observed, and let them decide (they can raise sleep.max_consecutive_timeouts in config if the watch is legitimate).",
              ].join(" "),
            ),
          )

        yield* ctx.ask({
          permission: "sleep_until",
          patterns: [params.observe, params.predicate],
          always: [params.observe, params.predicate],
          metadata: { description: params.description, command: `${params.observe} | ${params.predicate}` },
        })

        const instance = yield* InstanceState.context
        const cwd = instance.worktree ?? instance.directory

        // The proof gate. Three probes, each a mechanical verdict:
        //   1. observe runs and prints a state document;
        //   2. the live state is judged unmet (else there is nothing to wait for);
        //   3. met_example is judged met — the agent's fabricated positive must
        //      satisfy the agent's own predicate.
        // Together they prove the predicate discriminates "now" from "done", and
        // they force it to consume the state document: a predicate that ignores
        // stdin fails step 3. A trigger that can never fire is therefore not
        // expressible — the worst case left is firing early, which is visible.
        const tail2k = (output: string) => {
          const text = output.trim()
          return text.length > 0 ? text.slice(-2000) : undefined
        }
        const describeVerdict = (verdict: SessionSleepScheduler.CheckVerdict) =>
          verdict.kind === "met" ? "exit 0" : verdict.kind === "unmet" ? "exit 1" : `broken (${verdict.reason})`

        const observed = yield* scheduler.probe({
          condition: params.observe,
          cwd,
          timeoutMs: limits.checkTimeoutMs,
        })
        const observeFailure = SessionSleepScheduler.observeProblem(observed)
        if (observeFailure)
          return yield* Effect.fail(
            new Error(
              [
                `sleep_until refused to arm: the observe is broken — ${observeFailure}.`,
                "The observe must print the current state to stdout (its exit code is ignored).",
                tail2k(observed.output) !== undefined ? `Observe output:\n${tail2k(observed.output)}` : undefined,
              ]
                .filter(Boolean)
                .join("\n\n"),
            ),
          )

        const live = yield* scheduler.probe({
          condition: params.predicate,
          cwd,
          timeoutMs: limits.checkTimeoutMs,
          stdin: observed.output,
        })
        const liveVerdict = SessionSleepScheduler.classifyCheck(live)

        if (liveVerdict.kind === "met")
          return {
            title: "condition already met",
            output: [
              "The state already satisfies the predicate (exit 0). No sleep armed — there is nothing to wait for.",
              tail2k(observed.output) !== undefined ? `State:\n${tail2k(observed.output)}` : undefined,
              tail2k(live.output) !== undefined ? `Predicate:\n${tail2k(live.output)}` : undefined,
            ]
              .filter(Boolean)
              .join("\n\n"),
            metadata: { trigger_status: "not_armed" },
          }

        if (liveVerdict.kind === "broken")
          return yield* Effect.fail(
            new Error(
              [
                `sleep_until refused to arm: the predicate is broken on the live state — ${liveVerdict.reason}.`,
                "Nothing was armed. Fix the predicate so it exits 0 when met and 1 (with a progress line) when not met.",
                tail2k(live.output) !== undefined ? `Predicate output:\n${tail2k(live.output)}` : undefined,
              ]
                .filter(Boolean)
                .join("\n\n"),
            ),
          )

        const example = yield* scheduler.probe({
          condition: params.predicate,
          cwd,
          timeoutMs: limits.checkTimeoutMs,
          stdin: params.met_example,
        })
        const exampleVerdict = SessionSleepScheduler.classifyCheck(example)

        if (exampleVerdict.kind !== "met")
          return yield* Effect.fail(
            new Error(
              [
                "sleep_until refused to arm: your met_example does not satisfy your own predicate.",
                `Predicate on live state  → ${describeVerdict(liveVerdict)}: ${tail2k(live.output) ?? "(no output)"}`,
                `Predicate on met_example → ${describeVerdict(exampleVerdict)}: ${tail2k(example.output) ?? "(no output)"}`,
                "You cannot currently detect the state you are waiting for: either the predicate or the example is wrong — fix one, then re-arm. Nothing was armed.",
              ].join("\n\n"),
            ),
          )

        const trigger = yield* scheduler.arm({
          sessionID: ctx.sessionID,
          observe: params.observe,
          predicate: params.predicate,
          metExample: params.met_example,
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
          next_check_at: trigger.nextCheckAt,
          interval_ms: trigger.intervalMs,
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
            `Check: observe | predicate — proven at arm time (met_example → exit 0, live state → exit 1).`,
            `Checks run every ${intervalSeconds}s in the background; timeout at ${deadline}.`,
            `A broken check (bad exit code, command not found, timeout, or silent exit 1) counts toward a ${MAX_BROKEN_CHECKS}-strike breaker: reaching it disarms the trigger and wakes you.`,
            tail2k(observed.output) !== undefined ? `Live state now (unmet):\n${tail2k(observed.output)}` : undefined,
            "IMPORTANT: do not busy-wait with bash sleep while this trigger is armed — end your turn, or do unrelated work.",
            "The wake arrives automatically (even mid-turn) with the final state document. Call sleep_status to peek at the latest state without waiting.",
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
        "Arm a background trigger that wakes this session automatically when a state condition becomes true.",
        "Shape: `observe` prints the current state (the state document), `predicate` reads it on stdin and exits 0 = met / 1 = unmet (with a progress line), `met_example` is a literal state document that means done.",
        "Arm-time proof, enforced: the tool refuses to arm unless the observe runs, the live state is judged unmet, and your own predicate exits 0 on your met_example. A predicate that ignores stdin fails the met_example check, so predicates are state comparisons by construction — never-firing triggers are impossible to arm, and the worst case left is firing early, which is visible.",
        "If you cannot write a met_example, you cannot detect the state — refine observe/predicate instead of arming.",
        "Predicates containing time literals (clock times, dates, $(date …)) are refused unless allow_clock_predicate is true: time windows silently expire; wait for state instead.",
        "When armed, END YOUR TURN (or do unrelated work) — never busy-wait with sleep in bash while a trigger is armed; the wake message arrives automatically, even mid-turn, carrying the final state document. To see the latest state, call sleep_status instead of polling.",
        "The trigger survives server restarts. Arming again replaces the previous trigger; cancel with sleep_cancel.",
        `Broken checks accumulate while armed: ${MAX_BROKEN_CHECKS} of them disarm the trigger and wake you with the failure, so a misbehaving check can never spin silently until the timeout.`,
        "A session whose recent triggers all timed out without a met condition cannot re-arm: report to the user instead.",
        "Blessed shapes — file gained a line: observe `tail -n 50 /var/log/x.log`, predicate `grep -q 'pattern' && echo done || { echo 'not yet'; exit 1; }`; process exited: observe `pgrep -f '[w]ork.sh' || true`, predicate `grep -q . && { echo running; exit 1; }; echo exited`, met_example empty; URL healthy: observe `curl -s -o /dev/null -w '%{http_code}' https://example.com`, predicate `code=$(cat); [ \"$code\" = 200 ] && echo ok || { echo \"status $code\"; exit 1; }`, met_example `200`; command output contains marker: observe `<command> 2>&1`, predicate `grep -q 'Exit 0' && echo ok || { echo waiting; exit 1; }`.",
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
        "Peek at this session's sleep_until trigger without waiting: armed status, next check time, and the output of the most recent check (predicate progress, then the state document).",
        "Use it for progress while a trigger is armed (make your predicate print progress on exit 1) instead of blocking on bash sleep.",
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
          // Heartbeat: a pending trigger whose next check is far past due
          // means the background scheduler has not run it — the wake cannot
          // be trusted until that changes.
          const now = Date.now()
          const stalled =
            trigger.status === "pending" && now > trigger.nextCheckAt + Math.max(trigger.intervalMs * 2, 60_000)
          const budgetMs = trigger.deadline - trigger.timeCreated
          const elapsedPct =
            budgetMs > 0 ? Math.min(100, Math.max(0, Math.round(((now - trigger.timeCreated) / budgetMs) * 100))) : 0
          const lines = [
            `Trigger ${trigger.id}: ${trigger.status}`,
            `Waiting for: ${trigger.description}`,
            `Checks every ${Math.round(trigger.intervalMs / 1000)}s; next check ${new Date(trigger.nextCheckAt).toISOString()}; timeout ${new Date(trigger.deadline).toISOString()} (${elapsedPct}% of budget elapsed)`,
            elapsedPct >= 75 && trigger.status === "pending"
              ? "Over 75% of the timeout budget has elapsed without firing — sanity-check that this wait still makes sense; sleep_cancel and re-evaluate if not."
              : undefined,
            trigger.consecutiveFailures > 0
              ? `Broken checks: ${trigger.consecutiveFailures}/${MAX_BROKEN_CHECKS} — reaching ${MAX_BROKEN_CHECKS} disarms the trigger and wakes you.`
              : undefined,
            stalled
              ? `WARNING: checks are STALLED — the next check was due ${new Date(trigger.nextCheckAt).toISOString()} but has not run. The background scheduler looks wedged; this wake may never arrive and the timeout may not fire either. Do not keep waiting on it: inform the user, and use sleep_cancel to disarm this trigger.`
              : undefined,
            trigger.lastOutput ? `Last check output:\n${trigger.lastOutput}` : "No check output recorded yet.",
            trigger.status === "pending"
              ? stalled
                ? "The trigger is armed but unhealthy — surface the stall to the user."
                : "Still armed — end your turn or call sleep_cancel; the wake arrives automatically."
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
