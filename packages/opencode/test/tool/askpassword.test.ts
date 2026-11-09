import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect, Fiber, Queue } from "effect"
import { AskPasswordTool } from "../../src/tool/askpassword"
import { Question } from "../../src/question"
import { SessionID, MessageID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"
import { EventV2Bridge } from "../../src/event-v2-bridge"

const ctx = {
  sessionID: SessionID.make("ses_test-session"),
  messageID: MessageID.make("msg_test-message"),
  callID: "test-call",
  agent: "test-agent",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, Truncate.node, Agent.node, FSUtil.node])),
)

const pending = Effect.fn("AskPasswordToolTest.pending")(function* (question: Question.Interface) {
  const events = yield* EventV2Bridge.Service
  const asked = yield* Queue.unbounded<void>()
  const off = yield* events.listen((event) => {
    if (event.type === Question.Event.Asked.type) Queue.offerUnsafe(asked, undefined)
    return Effect.void
  })
  yield* Effect.addFinalizer(() => off)

  for (;;) {
    const items = yield* question.list()
    const item = items[0]
    if (item) return item
    yield* Queue.take(asked).pipe(Effect.timeout("2 seconds"))
  }
})

describe("tool.askpassword", () => {
  it.instance("stores the secret in the instance directory and returns only the path", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const question = yield* Question.Service
      const toolInfo = yield* AskPasswordTool
      const tool = yield* toolInfo.init()

      const fiber = yield* tool.execute({ title: "Deploy password", name: "Deploy Host!" }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      expect(item.questions[0]?.secret).toBe(true)
      yield* question.reply({ requestID: item.id, answers: [["hunter2"]] })

      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain(".opencode/secrets/deploy-host")
      expect(result.output).not.toContain("hunter2")
      expect(JSON.stringify(result)).not.toContain("hunter2")

      expect(yield* Effect.promise(() => fs.readFile(`${test.directory}/.opencode/secrets/deploy-host`, "utf8"))).toBe(
        "hunter2",
      )
      if (process.platform !== "win32") {
        const file = yield* Effect.promise(() => fs.stat(`${test.directory}/.opencode/secrets/deploy-host`))
        const dir = yield* Effect.promise(() => fs.stat(`${test.directory}/.opencode/secrets`))
        expect(file.mode & 0o777).toBe(0o600)
        expect(dir.mode & 0o777).toBe(0o700)
      }
    }),
  )

  it.instance("asks under the default name and reports dismissed prompts gracefully", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const question = yield* Question.Service
      const toolInfo = yield* AskPasswordTool
      const tool = yield* toolInfo.init()

      const fiber = yield* tool.execute({ title: "Sudo password" }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reject(item.id)

      const result = yield* Fiber.join(fiber)
      expect(result.output).toContain("dismissed")
      expect(
        yield* Effect.promise(() =>
          fs.access(`${test.directory}/.opencode/secrets/password`).then(
            () => true,
            () => false,
          ),
        ),
      ).toBe(false)
    }),
  )

  it.instance("keeps the secrets directory out of git without touching .gitignore", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const gitDir = `${test.directory}/.git/info`
      yield* Effect.promise(() => fs.mkdir(gitDir, { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(`${gitDir}/exclude`, "# manually ignored\n"))
      yield* Effect.promise(() => fs.writeFile(`${test.directory}/.gitignore`, "node_modules\n"))

      const question = yield* Question.Service
      const toolInfo = yield* AskPasswordTool
      const tool = yield* toolInfo.init()

      const fiber = yield* tool.execute({ title: "Deploy password" }, ctx).pipe(Effect.forkScoped)
      const item = yield* pending(question)
      yield* question.reply({ requestID: item.id, answers: [["hunter2"]] })
      yield* Fiber.join(fiber)

      const exclude = yield* Effect.promise(() => fs.readFile(`${gitDir}/exclude`, "utf8"))
      expect(exclude).toBe("# manually ignored\n.opencode/secrets/\n")
      const gitignore = yield* Effect.promise(() => fs.readFile(`${test.directory}/.gitignore`, "utf8"))
      expect(gitignore).toBe("node_modules\n")

      const fiberAgain = yield* tool.execute({ title: "Deploy password" }, ctx).pipe(Effect.forkScoped)
      const itemAgain = yield* pending(question)
      yield* question.reply({ requestID: itemAgain.id, answers: [["hunter2"]] })
      yield* Fiber.join(fiberAgain)

      const excludeAfterRepeat = yield* Effect.promise(() => fs.readFile(`${gitDir}/exclude`, "utf8"))
      expect(excludeAfterRepeat).toBe("# manually ignored\n.opencode/secrets/\n")
    }),
  )
})
