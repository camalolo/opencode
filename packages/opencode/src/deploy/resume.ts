import { and, desc, eq, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Layer, Option, Schema, Semaphore } from "effect"
import * as Fsp from "fs/promises"
import * as path from "path"
import { Database, Database as DatabaseNode } from "@opencode-ai/core/database/database"
import { Global } from "@opencode-ai/core/global"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionCrashRecovery } from "@opencode-ai/core/session/crash-recovery"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { InstanceStore } from "@/project/instance-store"
import { GlobalBus } from "@/bus/global"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { renderOutput } from "@/tool/task"

// Mirror of the Deploy restart flow: Deploy captures the sessions that were
// mid-turn right before it restarts the process, and this module resumes them
// at the next boot, so a deploy looks like a pause (plus a deploy notice)
// instead of a silent interrupt.
//
// The V1 session loop already resumes an unfinished turn when driven again
// (runLoop continues while the last assistant message never settled), and the
// boot-time crash sweep settles interrupted artifacts first, so resuming a
// plain session is one loop call. Interrupted `task` tool calls get one extra
// step: the subagent session is resumed to completion first and its real
// output is written back into the parent's tool part, otherwise the parent's
// resumed turn would see "aborted" and re-run the subagent from scratch.
// Subagents nest, so the settle recurses: a resumed parent waits for its
// subagent, which waits for its own subagents, just like the live task call
// did. The loop is driven with `resume: true` because the crash sweep settled
// the interrupted step — without it a step whose finish is already set would
// end the turn instead of continuing past its interrupted tools.
//
// The busy capture cannot see everything: a turn that wrapped up cleanly at a
// shutdown boundary went idle before the capture ran. Consume therefore also
// scans recent sessions for unfinished (non-aborted) turns and re-drives them.
// Only the captured set — the sessions actually interrupted mid-turn — gets
// the DEPLOY_NOTICE; scanned sessions resume silently.

const FILE = "deploy-resume.json"

/** Appended as a synthetic user turn into every session the deploy actually
 * interrupted mid-turn, before its resume loop runs: the model sees it as the
 * latest context and re-checks the last operation instead of assuming it
 * completed. Scanned (idle-unfinished) sessions resume without it. */
export const DEPLOY_NOTICE =
  "[Server was deployed, last operation might have failed, check if you need to perform last operation again]"

/** Captured sessions older than this are stale; the file is dropped instead of resumed. */
const MAX_AGE_MS = 30 * 60 * 1000

/** Boot-time cost scales with history, so only recently touched sessions are scanned for unfinished turns. */
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Provider turns are expensive; bound how many sessions resume concurrently. */
const CONCURRENCY = 3

/** Let the boot storm (plugins, providers, listeners) settle before resuming. */
const START_DELAY = Duration.seconds(5)

export const file = () => path.join(Global.Path.data, FILE)

export interface BootResume {
  startedAt: number
  sessions: Array<string>
}

/**
 * Reads a still-fresh capture without consuming it. The layer checks this at
 * boot to announce the resume phase; stale, empty, or missing files announce
 * nothing, matching what consume() would resume.
 */
export const readCapture = async (): Promise<{ at: number; sessions: Array<string> } | undefined> => {
  try {
    const parsed = decode(JSON.parse(await Bun.file(file()).text()))
    if (Date.now() - parsed.at > MAX_AGE_MS || parsed.sessions.length === 0) return undefined
    return { at: parsed.at, sessions: [...parsed.sessions] }
  } catch {
    return undefined
  }
}

const Persisted = Schema.Struct({
  version: Schema.Literal(1),
  at: Schema.Number,
  sessions: Schema.Array(Schema.String),
})

const encode = Schema.encodeSync(Persisted)
const decode = Schema.decodeUnknownSync(Persisted)

/**
 * Records the sessions a deploy is about to interrupt. Called by Deploy in its
 * restart phase, after the drain; an empty list writes nothing so boots with
 * no pending work skip the file entirely.
 */
export const capture = Effect.fn("DeployResume.capture")(function* (sessionIDs: ReadonlyArray<SessionID>) {
  if (sessionIDs.length === 0) return
  const payload = JSON.stringify(encode({ version: 1, at: Date.now(), sessions: [...sessionIDs] }))
  yield* Effect.tryPromise(() => Bun.write(file(), payload)).pipe(
    Effect.tapError((error) => Effect.logWarning("deploy resume capture failed", { error: String(error) })),
    Effect.ignore,
  )
  yield* Effect.logInfo("deploy resume captured interrupted sessions", { sessions: [...sessionIDs] })
})

/** Drops the capture; called when the deploy fails after capturing, so the
 * next boot does not resume sessions that were never actually interrupted. */
export const discard = Effect.fn("DeployResume.discard")(function* () {
  yield* Effect.tryPromise(() => Fsp.rm(file(), { force: true })).pipe(Effect.ignore)
})

export interface Interface {
  /** Reads and consumes the resume file now. Boot runs this forked; tests call it directly. */
  readonly consume: () => Effect.Effect<void>
  /** Boot-resume view for the deploy status: set while the boot consume is
   * settling a deploy capture, undefined once it settles (or when the boot had
   * no capture). */
  readonly boot: () => Effect.Effect<BootResume | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/DeployResume") {}

/**
 * The subagent session of an interrupted `task` tool call, if this part is one.
 * Only calls the crash sweep / interrupt cleanup marked as interrupted qualify;
 * a call that failed for a real reason is left alone.
 */
const interruptedSubtask = (part: SessionV1.Part): SessionID | undefined => {
  if (part.type !== "tool" || part.tool !== "task") return undefined
  if (part.state.status !== "error" || part.state.metadata?.interrupted !== true) return undefined
  const child = part.state.metadata.sessionId
  return typeof child === "string" ? SessionID.make(child) : undefined
}

// The stored message data column is JSON, so read just the assistant fields
// the unfinished-turn scan needs.
const asAssistant = (info: unknown): { finish?: string; error?: unknown } | undefined => {
  if (typeof info !== "object" || info === null) return undefined
  const record = info as { role?: unknown; finish?: unknown; error?: unknown }
  if (record.role !== "assistant") return undefined
  return {
    finish: typeof record.finish === "string" ? record.finish : undefined,
    error: record.error,
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const instances = yield* InstanceStore.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const slots = Semaphore.makeUnsafe(CONCURRENCY)
    const fileLock = Semaphore.makeUnsafe(1)
    // File entries still awaiting a resume verdict. Guarded by fileLock;
    // rewritten on every settle so an interrupted resume boot leaves the
    // remaining sessions armed for the next boot.
    let remaining: string[] = []

    const removeFile = Effect.tryPromise(() => Fsp.rm(file(), { force: true })).pipe(Effect.ignore)

    const drop = (sessionID: string, at: number) =>
      fileLock.withPermit(
        Effect.gen(function* () {
          remaining = remaining.filter((id) => id !== sessionID)
          if (remaining.length === 0) return yield* removeFile
          const payload = JSON.stringify(encode({ version: 1, at, sessions: remaining }))
          yield* Effect.tryPromise(() => Bun.write(file(), payload)).pipe(Effect.ignore)
        }),
      )

    /**
     * Sessions whose last turn stopped without finishing: no finish reason (or
     * a "tool-calls"/"unknown" one) and no error recorded — an error means the
     * user aborted it or a crash sweep settled it, and both should stay put.
     * Subagent sessions are skipped: their parent continues them through the
     * task tool's task_id, which avoids parent and child working in parallel.
     * Over-inclusion is harmless — the loop re-checks precisely and exits
     * without a provider call when the turn is actually complete.
     */
    const scanUnfinished = Effect.fn("DeployResume.scanUnfinished")(function* () {
      const cutoff = Date.now() - RECENT_WINDOW_MS
      const recent = yield* db
        .select({ id: SessionTable.id, parent_id: SessionTable.parent_id })
        .from(SessionTable)
        .where(sql`max(${SessionTable.time_updated}, ${SessionTable.time_created}) >= ${cutoff}`)
        .all()
        .pipe(Effect.orDie)
      const found: string[] = []
      for (const session of recent) {
        if (session.parent_id) continue
        const row = yield* db
          .select({ data: MessageTable.data })
          .from(MessageTable)
          .where(
            and(
              eq(MessageTable.session_id, session.id),
              sql`json_extract(${MessageTable.data}, '$.role') = 'assistant'`,
            ),
          )
          .orderBy(desc(MessageTable.time_created), desc(MessageTable.id))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        const assistant = row ? asAssistant(row.data) : undefined
        if (!assistant) continue
        if (assistant.error !== undefined) continue
        // Provider-cut turns (stream died / Z.AI repetition cutoff) are
        // unfinished: re-drive them after the reboot like the tool-calls case.
        if (
          assistant.finish === undefined ||
          assistant.finish === "tool-calls" ||
          assistant.finish === "unknown" ||
          assistant.finish === "repetition"
        )
          found.push(session.id)      }
      return found
    })

    /** Writes a resumed subagent's final answer into the parent's task call, so
     * the parent's provider turn continues with the real result. */
    const repairSubtask = Effect.fn("DeployResume.repairSubtask")(function* (part: SessionV1.ToolPart, childID: SessionID) {
      if (part.state.status !== "error") return
      const childMessages = yield* sessions.messages({ sessionID: childID }).pipe(Effect.orDie)
      const last = childMessages.findLast((message) => message.info.role === "assistant")
      const failed = last?.info.role === "assistant" && last.info.error !== undefined
      const text = last?.parts.findLast((item): item is SessionV1.TextPart => item.type === "text")?.text ?? ""
      const description = typeof part.state.input.description === "string" ? part.state.input.description : "task"
      const metadata = { ...part.state.metadata }
      delete metadata.interrupted
      yield* sessions.updatePart({
        ...part,
        state: {
          status: "completed",
          input: part.state.input,
          output: renderOutput({
            sessionID: childID,
            state: failed ? "error" : "completed",
            summary: `${failed ? "Subagent task failed" : "Subagent task completed"} (continued after a server restart): ${description}`,
            text,
          }),
          title: description,
          metadata,
          time: { start: part.state.time.start, end: Date.now() },
        },
      })
    })

    /** Resumes one session depth-first: its interrupted task subtasks finish
     * first (recursively, their results written back into this session's tool
     * parts), then this session's own turn continues — the ordering a live
     * task call has, so a resumed parent waits for its subagent exactly like
     * before the deploy, at any nesting depth. */
    const resumeSession: (
      sessionID: SessionID,
      seen: Set<SessionID>,
    ) => Effect.Effect<SessionV1.WithParts> = Effect.fn("DeployResume.resumeSession")(function* (
      sessionID: SessionID,
      seen: Set<SessionID>,
    ) {
      yield* settleSubtasks(sessionID, seen)
      return yield* prompt.loop({ sessionID, resume: true })
    })

    const settleSubtasks: (sessionID: SessionID, seen: Set<SessionID>) => Effect.Effect<void> = Effect.fn(
      "DeployResume.settleSubtasks",
    )(function* (sessionID: SessionID, seen: Set<SessionID>) {
      const messages = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const last = messages.findLast((message) => message.info.role === "assistant")
      if (!last) return
      for (const part of last.parts) {
        const childID = interruptedSubtask(part)
        // the tool/error re-checks narrow `part` for repairSubtask
        if (!childID || part.type !== "tool" || part.state.status !== "error") continue
        // Metadata is durable and could in principle name an already-visited
        // session; resuming it twice would nest the same turn into itself.
        if (seen.has(childID)) continue
        if (!(yield* store.get(childID))) continue
        seen.add(childID)
        const exit = yield* resumeSession(childID, seen).pipe(Effect.exit)
        // Shutdown raced the resume; leave the parent entry armed for next boot.
        if (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)
        // A failed child resume leaves the part interrupted, so the parent model
        // re-runs the task from scratch instead of trusting a broken answer.
        if (exit._tag === "Success") yield* repairSubtask(part, childID)
      }
    })

    /** Writes the deploy notice as a synthetic user turn. Model context comes
     * from the session's own latest user message, so the projection treats it
     * like any other user turn; sessions without prompting history (nothing to
     * copy) skip the notice — they cannot be mid-turn anyway. */
    const appendDeployNotice = Effect.fn("DeployResume.appendDeployNotice")(function* (sessionID: SessionID) {
      const last = yield* sessions
        .findMessage(sessionID, (m) => m.info.role === "user" && !!m.info.model)
        .pipe(Effect.orDie)
      if (Option.isNone(last)) {
        yield* Effect.logWarning("deploy notice skipped: no user model context", { sessionID })
        return
      }
      const source = last.value
      if (source.info.role !== "user") return
      const info: SessionV1.User = {
        id: MessageID.ascending(),
        role: "user",
        sessionID,
        time: { created: Date.now() },
        agent: source.info.agent,
        model: source.info.model,
      }
      yield* sessions.updateMessage(info)
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: info.id,
        sessionID,
        type: "text",
        synthetic: true,
        text: DEPLOY_NOTICE,
      })
      yield* sessions.touch(sessionID)
      yield* Effect.logInfo("deploy notice appended", { sessionID })
    })

    const resumeInInstance = Effect.fn("DeployResume.resumeInInstance")(function* (sessionID: SessionID, notify: boolean) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      const seen = new Set<SessionID>([sessionID])
      // Settle subtasks for every session, subagents included: a captured
      // subagent can itself have been waiting on nested subagents.
      yield* settleSubtasks(sessionID, seen)
      // Only the root session gets the notice — it is the conversation the
      // user was in. A subagent just continues its interrupted work.
      if (notify && !session.parentID) yield* appendDeployNotice(sessionID)
      return yield* prompt.loop({ sessionID, resume: true })
    })

    const resumeOne = Effect.fn("DeployResume.resumeOne")(function* (id: string, at: number | undefined, notify: boolean) {
      const sessionID = SessionID.make(id)
      const session = yield* store.get(sessionID)
      if (!session) {
        yield* Effect.logWarning("deploy resume skipped: session not found", { sessionID: id })
        if (at !== undefined) yield* drop(id, at)
        return
      }
      const exit = yield* instances
        .provide({ directory: session.location.directory }, resumeInInstance(sessionID, notify))
        .pipe(Effect.exit)
      // An interrupted resume keeps its entry (a scan re-finds it next boot;
      // the file keeps captured ones), so the next boot retries; any other
      // verdict is final.
      if (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)) return
      if (exit._tag === "Failure") {
        yield* Effect.logError("deploy resume failed", { sessionID: id, cause: Cause.pretty(exit.cause) })
      } else {
        yield* Effect.logInfo("deploy resume finished", { sessionID: id })
      }
      if (at !== undefined) yield* drop(id, at)
    })

    const consume: Interface["consume"] = Effect.fn("DeployResume.consume")(function* () {
      // File part: sessions the deploy saw still busy at the restart.
      let capturedAt: number | undefined
      const raw = yield* Effect.tryPromise(() => Bun.file(file()).text()).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (raw !== undefined) {
        const parsed = yield* Effect.try({
          try: () => decode(JSON.parse(raw)),
          catch: (error) => error,
        }).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (parsed === undefined) {
          yield* Effect.logWarning("deploy resume file was invalid; ignoring it")
          yield* removeFile
        } else if (Date.now() - parsed.at > MAX_AGE_MS) {
          yield* Effect.logWarning("deploy resume file was stale; ignoring it", { at: parsed.at })
          yield* removeFile
        } else if (parsed.sessions.length === 0) {
          yield* removeFile
        } else {
          capturedAt = parsed.at
          remaining = [...parsed.sessions]
        }
      }
      // Scan part: turns that wrapped up at a shutdown boundary (or were cut
      // mid-stream) and are idle-unfinished — invisible to the busy capture.
      // They resume silently: only the captured set (actively interrupted)
      // gets the deploy notice.
      const scanned = yield* scanUnfinished()
      const ids = [...new Set([...remaining, ...scanned])]
      if (ids.length === 0) return
      yield* Effect.logInfo("resuming sessions with unfinished work", { sessions: ids })
      yield* Effect.forEach(
        ids,
        (id) => slots.withPermit(resumeOne(id, capturedAt, remaining.includes(id))),
        {
          concurrency: CONCURRENCY,
          discard: true,
        },
      )
    })

    // A deploy restart leaves the capture file behind; while the boot consume
    // settles it, the deploy status reports the "resume" phase so the web UI
    // holds its deploy screen (instead of showing an idle server that is
    // actually still restoring turns). Announcements ride the global bus both
    // ways: "resume" at boot, "idle" when the settle completes — even if the
    // consume died or hangs past the deadline, so clients can never wedge on
    // a stuck resume.
    let boot: BootResume | undefined

    const announceBoot = (phase: "resume" | "idle") =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: "server.deploy",
          properties: {
            phase,
            ...(boot ? { startedAt: boot.startedAt } : {}),
            ...(boot && boot.sessions.length > 0 ? { activeSessions: boot.sessions } : {}),
          },
        },
      })

    const capture = yield* Effect.promise(() => readCapture())
    if (capture) {
      boot = { startedAt: Date.now(), sessions: capture.sessions }
      yield* Effect.logInfo("boot resume: restoring sessions interrupted by the deploy", { sessions: capture.sessions })
      announceBoot("resume")
    }

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* consume().pipe(
          Effect.timeout("30 minutes"),
          Effect.catchCause((cause) => Effect.logError("boot resume failed", Cause.pretty(cause))),
        )
        if (boot === undefined) return
        boot = undefined
        announceBoot("idle")
      }).pipe(Effect.delay(START_DELAY)),
    )

    const bootStatus: Interface["boot"] = Effect.fn("DeployResume.boot")(function* () {
      return boot
    })

    return Service.of({ consume, boot: bootStatus })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionCrashRecovery.node, DatabaseNode.node, SessionStore.node, InstanceStore.node, SessionPrompt.node, Session.node],
})

export * as DeployResume from "./resume"
