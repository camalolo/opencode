import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Fsp from "fs/promises"
import { DeployResume } from "../../src/deploy/resume"
import { MessageV2 } from "../../src/session/message-v2"
import { InstanceStore } from "@/project/instance-store"
import { Session as SessionNs } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { pollWithTimeout, testEffect } from "../lib/effect"

const insertSession = (db: Database.Interface["db"], sessionID: string, parentID?: string) =>
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
        ...(parentID ? { parent_id: SessionSchema.ID.make(parentID) } : {}),
        slug: sessionID,
        directory: AbsolutePath.make("/tmp/test"),
        title: "test",
        version: "test",
        time_created: Date.now(),
        time_updated: Date.now(),
      })
      .run()
      .pipe(Effect.orDie)
  })

const userMessage = (sessionID: SessionID) =>
  ({
    id: MessageID.ascending(),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID: ProviderV2.ID.make("test"), modelID: ModelV2.ID.make("test-model") },
  }) as unknown as SessionV1.Info

const assistantMessage = (
  sessionID: SessionID,
  parentID: MessageID,
  opts?: { finish?: string; error?: unknown },
) =>
  ({
    id: MessageID.ascending(),
    sessionID,
    role: "assistant",
    parentID,
    time: { created: Date.now() },
    modelID: ModelV2.ID.make("test-model"),
    providerID: ProviderV2.ID.make("test"),
    agent: "build",
    mode: "",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: opts?.finish,
    error: opts?.error,
  }) as unknown as SessionV1.Info

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

const writeCapture = (at: number, sessions: string[]) =>
  Effect.promise(() => Fsp.writeFile(DeployResume.file(), JSON.stringify({ version: 1, at, sessions }))).pipe(
    Effect.orDie,
  )

const fileExists = Effect.gen(function* () {
  return yield* Effect.promise(() => Fsp.access(DeployResume.file()).then(() => true, () => false))
})

const makeResume = (loopImpl: (input: SessionPrompt.LoopInput) => Effect.Effect<SessionV1.WithParts> = (input) =>
  Effect.succeed(fakeWithParts(input.sessionID))) => {
  const calls: SessionID[] = []
  const prompt = Layer.mock(SessionPrompt.Service, {
    loop: (input) =>
      Effect.suspend(() => {
        calls.push(input.sessionID)
        return loopImpl(input)
      }),
  })
  const instances = Layer.mock(InstanceStore.Service, {
    provide: <A, E, R>(_input: InstanceStore.LoadInput, effect: Effect.Effect<A, E, R>) => effect,
  })
  const it = testEffect(
    LayerNode.compile(
      LayerNode.group([DeployResume.node, Database.node, SessionProjector.node, SessionNs.node, MessageV2.node]),
      [
        [InstanceStore.node, instances],
        [SessionPrompt.node, prompt],
      ] as const,
    ),
  )
  return { it, calls }
}

describe("deploy resume", () => {
  beforeEach(async () => {
    await Fsp.rm(DeployResume.file(), { force: true })
  })

  // a fresh layer per test: each makeResume() call owns its loop-mock state
  const resumes = makeResume()

  resumes.it.effect("resumes captured sessions and consumes the file", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_resume_ok")
      yield* writeCapture(Date.now(), ["ses_resume_ok"])
      const svc = yield* DeployResume.Service

      yield* svc.consume()

      expect(resumes.calls).toEqual([SessionID.make("ses_resume_ok")])
      expect(yield* fileExists).toBe(false)
    }),
  )

  const ghost = makeResume()

  ghost.it.effect("skips sessions that no longer exist", () =>
    Effect.gen(function* () {
      yield* writeCapture(Date.now(), ["ses_ghost"])
      const svc = yield* DeployResume.Service

      yield* svc.consume()

      expect(ghost.calls).toEqual([])
      expect(yield* fileExists).toBe(false)
    }),
  )

  const stale = makeResume()

  stale.it.effect("ignores stale captures", () =>
    Effect.gen(function* () {
      yield* writeCapture(Date.now() - 2 * 60 * 60 * 1000, ["ses_resume_stale"])
      const svc = yield* DeployResume.Service

      yield* svc.consume()

      expect(stale.calls).toEqual([])
      expect(yield* fileExists).toBe(false)
    }),
  )

  const invalid = makeResume()

  invalid.it.effect("ignores an invalid capture file", () =>
    Effect.gen(function* () {
      yield* Effect.promise(() => Fsp.writeFile(DeployResume.file(), "not json")).pipe(Effect.orDie)
      const svc = yield* DeployResume.Service

      yield* svc.consume()

      expect(invalid.calls).toEqual([])
      expect(yield* fileExists).toBe(false)
    }),
  )

  const interrupted = makeResume(() => Effect.interrupt)

  interrupted.it.effect("keeps the entry when a resume is interrupted", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* insertSession(db, "ses_resume_interrupted")
      yield* writeCapture(Date.now(), ["ses_resume_interrupted"])
      const svc = yield* DeployResume.Service

      yield* svc.consume()

      expect(interrupted.calls).toEqual([SessionID.make("ses_resume_interrupted")])
      expect(yield* fileExists).toBe(true)
    }),
  )

  const subtask = makeResume()

  subtask.it.effect(
    "settles an interrupted subagent task before resuming the parent",
    () =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* insertSession(db, "ses_parent")
        yield* insertSession(db, "ses_child", "ses_parent")
        const sessions = yield* SessionNs.Service
        const parentID = SessionID.make("ses_parent")
        const childID = SessionID.make("ses_child")

        const parentUser = userMessage(parentID)
        yield* sessions.updateMessage(parentUser)
        const parentAssistant = assistantMessage(parentID, parentUser.id)
        yield* sessions.updateMessage(parentAssistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: parentID,
          messageID: parentAssistant.id,
          type: "tool",
          tool: "task",
          callID: "call_research",
          state: {
            status: "error",
            input: { description: "Research the bug", prompt: "investigate", subagent_type: "explore" },
            error: "aborted: opencode stopped before this tool call finished, its result is unknown; re-run if needed",
            metadata: { parentSessionId: parentID, sessionId: childID, interrupted: true },
            time: { start: Date.now() - 1000, end: Date.now() },
          },
        })
        const childUser = userMessage(childID)
        yield* sessions.updateMessage(childUser)
        const childAssistant = assistantMessage(childID, childUser.id)
        yield* sessions.updateMessage(childAssistant)
        yield* sessions.updatePart({
          id: PartID.ascending(),
          sessionID: childID,
          messageID: childAssistant.id,
          type: "text",
          text: "Child finished the work",
        })

        // only the parent was still busy at capture time
        yield* writeCapture(Date.now(), [parentID])
        const svc = yield* DeployResume.Service

        yield* svc.consume()

        // the child was settled first, then the parent's turn was re-driven
        expect(subtask.calls).toEqual([childID, parentID])

        const messages = yield* sessions.messages({ sessionID: parentID })
        const assistant = messages.findLast((message) => message.info.role === "assistant")
        const tool = assistant?.parts.find((part): part is SessionV1.ToolPart => part.type === "tool")
        expect(tool?.state.status).toBe("completed")
        if (tool?.state.status === "completed") {
          expect(tool.state.output).toContain("Child finished the work")
          expect(tool.state.metadata?.interrupted).toBeUndefined()
          expect(tool.state.metadata?.sessionId).toBe(childID)
        }
        expect(yield* fileExists).toBe(false)
      }),
    30_000,
  )

  const scan = makeResume()

  scan.it.effect(
    "scan resumes idle sessions with unfinished turns and skips the rest",
    () =>
      Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const sessions = yield* SessionNs.Service

        // unfinished, no error: the shutdown-boundary wrap-up case
        yield* insertSession(db, "ses_scan_unfinished")
        const unfinishedID = SessionID.make("ses_scan_unfinished")
        const unfinishedUser = userMessage(unfinishedID)
        yield* sessions.updateMessage(unfinishedUser)
        yield* sessions.updateMessage(assistantMessage(unfinishedID, unfinishedUser.id))

        // user-aborted turn: stays put
        yield* insertSession(db, "ses_scan_aborted")
        const abortedID = SessionID.make("ses_scan_aborted")
        const abortedUser = userMessage(abortedID)
        yield* sessions.updateMessage(abortedUser)
        yield* sessions.updateMessage(
          assistantMessage(abortedID, abortedUser.id, { error: new SessionV1.AbortedError({ message: "Aborted" }) }),
        )

        // finished normally: stays put
        yield* insertSession(db, "ses_scan_done")
        const doneID = SessionID.make("ses_scan_done")
        const doneUser = userMessage(doneID)
        yield* sessions.updateMessage(doneUser)
        yield* sessions.updateMessage(assistantMessage(doneID, doneUser.id, { finish: "stop" }))

        // unfinished but a subagent session: its parent continues it
        yield* insertSession(db, "ses_scan_child", "ses_scan_parent")
        const childID = SessionID.make("ses_scan_child")
        const childUser = userMessage(childID)
        yield* sessions.updateMessage(childUser)
        yield* sessions.updateMessage(assistantMessage(childID, childUser.id))

        const svc = yield* DeployResume.Service

        // message events persist asynchronously
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const rows = yield* Effect.tryPromise(() =>
              db.select().from(MessageTable).all().pipe(Effect.runPromise),
            ).pipe(Effect.orDie)
            return rows.length >= 8 ? (true as const) : undefined
          }),
          "messages never persisted",
        )

        yield* svc.consume()

        expect(scan.calls).toEqual([unfinishedID])
        expect(yield* fileExists).toBe(false)
      }),
    30_000,
  )
})
