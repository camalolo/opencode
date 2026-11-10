import { Cause, Context, Duration, Effect, Layer, Schema, Semaphore } from "effect"
import * as Fsp from "fs/promises"
import * as path from "path"
import { Global } from "@opencode-ai/core/global"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionCrashRecovery } from "@opencode-ai/core/session/crash-recovery"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { InstanceStore } from "@/project/instance-store"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { renderOutput } from "@/tool/task"

// Mirror of the Deploy restart flow: Deploy captures the sessions that were
// mid-turn right before it restarts the process, and this module resumes them
// at the next boot, so a deploy looks like a pause instead of an interrupt.
//
// The V1 session loop already resumes an unfinished turn when driven again
// (runLoop continues while the last assistant message never settled), and the
// boot-time crash sweep settles interrupted artifacts first, so resuming a
// plain session is one loop call. Interrupted `task` tool calls get one extra
// step: the subagent session is resumed to completion first and its real
// output is written back into the parent's tool part, otherwise the parent's
// resumed turn would see "aborted" and re-run the subagent from scratch.

const FILE = "deploy-resume.json"

/** Captured sessions older than this are stale; the file is dropped instead of resumed. */
const MAX_AGE_MS = 30 * 60 * 1000

/** Provider turns are expensive; bound how many sessions resume concurrently. */
const CONCURRENCY = 3

/** Let the boot storm (plugins, providers, listeners) settle before resuming. */
const START_DELAY = Duration.seconds(5)

export const file = () => path.join(Global.Path.data, FILE)

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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const instances = yield* InstanceStore.Service
    const prompt = yield* SessionPrompt.Service
    const sessions = yield* Session.Service
    const slots = Semaphore.makeUnsafe(CONCURRENCY)
    const fileLock = Semaphore.makeUnsafe(1)
    // Entries still awaiting a resume verdict. Guarded by fileLock; rewritten
    // on every settle so an interrupted resume boot leaves the remaining
    // sessions armed for the next boot.
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

    const settleSubtasks = Effect.fn("DeployResume.settleSubtasks")(function* (sessionID: SessionID) {
      const messages = yield* sessions.messages({ sessionID }).pipe(Effect.orDie)
      const last = messages.findLast((message) => message.info.role === "assistant")
      if (!last) return
      for (const part of last.parts) {
        const childID = interruptedSubtask(part)
        // the tool/error re-checks narrow `part` for repairSubtask
        if (!childID || part.type !== "tool" || part.state.status !== "error") continue
        if (!(yield* store.get(childID))) continue
        const exit = yield* prompt.loop({ sessionID: childID }).pipe(Effect.exit)
        // Shutdown raced the resume; leave the parent entry armed for next boot.
        if (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause)
        // A failed child resume leaves the part interrupted, so the parent model
        // re-runs the task from scratch instead of trusting a broken answer.
        if (exit._tag === "Success") yield* repairSubtask(part, childID)
      }
    })

    const resumeInInstance = Effect.fn("DeployResume.resumeInInstance")(function* (sessionID: SessionID) {
      const session = yield* sessions.get(sessionID).pipe(Effect.orDie)
      // Subagent sessions resume like any other turn; their parent settles them.
      if (session.parentID) return yield* prompt.loop({ sessionID })
      yield* settleSubtasks(sessionID)
      return yield* prompt.loop({ sessionID })
    })

    const resumeOne = Effect.fn("DeployResume.resumeOne")(function* (id: string, at: number) {
      const sessionID = SessionID.make(id)
      const session = yield* store.get(sessionID)
      if (!session) {
        yield* Effect.logWarning("deploy resume skipped: session not found", { sessionID: id })
        return yield* drop(id, at)
      }
      const exit = yield* instances
        .provide({ directory: session.location.directory }, resumeInInstance(sessionID))
        .pipe(Effect.exit)
      // An interrupted resume (another restart raced it) keeps its entry so the
      // next boot retries; any other verdict is final.
      if (exit._tag === "Failure" && Cause.hasInterruptsOnly(exit.cause)) return
      if (exit._tag === "Failure") {
        yield* Effect.logError("deploy resume failed", { sessionID: id, cause: Cause.pretty(exit.cause) })
      } else {
        yield* Effect.logInfo("deploy resume finished", { sessionID: id })
      }
      yield* drop(id, at)
    })

    const consume: Interface["consume"] = Effect.fn("DeployResume.consume")(function* () {
      const raw = yield* Effect.tryPromise(() => Bun.file(file()).text()).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      )
      if (raw === undefined) return
      const parsed = yield* Effect.try({
        try: () => decode(JSON.parse(raw)),
        catch: (error) => error,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (parsed === undefined) {
        yield* Effect.logWarning("deploy resume file was invalid; ignoring it")
        return yield* removeFile
      }
      if (Date.now() - parsed.at > MAX_AGE_MS) {
        yield* Effect.logWarning("deploy resume file was stale; ignoring it", { at: parsed.at })
        return yield* removeFile
      }
      if (parsed.sessions.length === 0) return yield* removeFile
      remaining = [...parsed.sessions]
      yield* Effect.logInfo("resuming sessions interrupted by the deploy restart", { sessions: remaining })
      yield* Effect.forEach(parsed.sessions, (id) => slots.withPermit(resumeOne(id, parsed.at)), {
        concurrency: CONCURRENCY,
        discard: true,
      })
    })

    yield* Effect.forkScoped(consume().pipe(Effect.delay(START_DELAY)))

    return Service.of({ consume })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionCrashRecovery.node, SessionStore.node, InstanceStore.node, SessionPrompt.node, Session.node],
})

export * as DeployResume from "./resume"
