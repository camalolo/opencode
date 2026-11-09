import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterEach, describe, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Layer } from "effect"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionID, MessageID } from "../../src/session/schema"
import { SendFileToUserTool } from "../../src/tool/send-file-to-user"
import { Truncate } from "@/tool/truncate"
import { Tool } from "@/tool/tool"
import {
  disposeAllInstances,
  provideInstance,
  testInstanceStoreLayer,
  tmpdirScoped,
} from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const sendFileLayer = LayerNode.compile(
  LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Ripgrep.node, Truncate.node]),
)

const it = testEffect(Layer.mergeAll(sendFileLayer, testInstanceStoreLayer))

const init = Effect.fn("SendFileToUserToolTest.init")(function* () {
  const info = yield* SendFileToUserTool
  return yield* info.init()
})

const run = Effect.fn("SendFileToUserToolTest.run")(function* (
  args: Tool.InferParameters<typeof SendFileToUserTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("SendFileToUserToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof SendFileToUserTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("SendFileToUserToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof SendFileToUserTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected send_file_to_user to fail")
})

const put = Effect.fn("SendFileToUserToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
  const fs = yield* FSUtil.Service
  yield* fs.writeWithDirs(p, content)
})

const asks = () => {
  const items: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
  return {
    items,
    next: {
      ...ctx,
      ask: (req: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) =>
        Effect.sync(() => {
          items.push(req)
        }),
    },
  }
}

describe("tool.send_file_to_user", () => {
  it.live("returns download metadata without embedding bytes", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "report.csv")
      yield* put(filepath, "id,name\n1,test\n")

      const result = yield* exec(dir, { filePath: filepath })
      expect(result.output).toContain("report.csv")
      expect(result.metadata.path).toBe(filepath)
      expect(result.metadata.filename).toBe("report.csv")
      expect(result.metadata.mime).toBe("text/csv")
      expect(result.metadata.size).toBe(15)
      expect(result.metadata.download).toBe(true)
    }),
  )

  it.live("resolves relative paths against the project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "archive.zip"), Buffer.alloc(8))

      const result = yield* exec(dir, { filePath: "subdir/archive.zip" })
      expect(result.metadata.filename).toBe("archive.zip")
      expect(result.metadata.path).toBe(path.join(dir, "subdir", "archive.zip"))
    }),
  )

  it.live("asks for read permission", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "report.csv")
      yield* put(filepath, "data")

      const { items, next } = asks()
      yield* exec(dir, { filePath: filepath }, next)
      const read = items.find((item) => item.permission === "read")
      expect(read).toBeDefined()
      expect(read!.patterns.some((pattern) => pattern.endsWith("report.csv"))).toBe(true)
    }),
  )

  it.live("fails when the file does not exist", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const err = yield* fail(dir, { filePath: path.join(dir, "missing.csv") })
      expect(err.message).toContain("File not found")
    }),
  )

  it.live("fails for directories", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "keep.txt"), "x")
      const err = yield* fail(dir, { filePath: path.join(dir, "subdir") })
      expect(err.message).toContain("Not a file")
    }),
  )

  it.live("fails for files outside the project", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const outside = yield* tmpdirScoped()
      const filepath = path.join(outside, "secret.txt")
      yield* put(filepath, "data")

      const err = yield* fail(dir, { filePath: filepath })
      expect(err.message).toContain("outside the project")
    }),
  )
})
