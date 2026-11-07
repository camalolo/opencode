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
import { ShowImageTool } from "../../src/tool/show-image"
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

// 1x1 transparent PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

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

const showImageLayer = LayerNode.compile(
  LayerNode.group([Agent.node, FSUtil.node, CrossSpawnSpawner.node, Ripgrep.node, Truncate.node]),
)

const it = testEffect(Layer.mergeAll(showImageLayer, testInstanceStoreLayer))

const init = Effect.fn("ShowImageToolTest.init")(function* () {
  const info = yield* ShowImageTool
  return yield* info.init()
})

const run = Effect.fn("ShowImageToolTest.run")(function* (
  args: Tool.InferParameters<typeof ShowImageTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

const exec = Effect.fn("ShowImageToolTest.exec")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ShowImageTool>,
  next: Tool.Context = ctx,
) {
  return yield* provideInstance(dir)(run(args, next))
})

const fail = Effect.fn("ShowImageToolTest.fail")(function* (
  dir: string,
  args: Tool.InferParameters<typeof ShowImageTool>,
  next: Tool.Context = ctx,
) {
  const exit = yield* exec(dir, args, next).pipe(Effect.exit)
  if (Exit.isFailure(exit)) {
    const err = Cause.squash(exit.cause)
    return err instanceof Error ? err : new Error(String(err))
  }
  throw new Error("expected show_image to fail")
})

const put = Effect.fn("ShowImageToolTest.put")(function* (p: string, content: string | Buffer | Uint8Array) {
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

describe("tool.show_image", () => {
  it.live("attaches a png as a data url", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "picture.png")
      yield* put(filepath, PNG)

      const result = yield* exec(dir, { filePath: filepath })
      expect(result.output).toContain(filepath)
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments![0].mime).toBe("image/png")
      expect(result.attachments![0].url).toStartWith("data:image/png;base64,")
    }),
  )

  it.live("resolves relative paths against the project directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* put(path.join(dir, "subdir", "picture.png"), PNG)

      const result = yield* exec(dir, { filePath: "subdir/picture.png" })
      expect(result.attachments).toHaveLength(1)
      expect(result.attachments![0].mime).toBe("image/png")
    }),
  )

  it.live("asks for read permission", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "picture.png")
      yield* put(filepath, PNG)

      const { items, next } = asks()
      yield* exec(dir, { filePath: filepath }, next)
      const read = items.find((item) => item.permission === "read")
      expect(read).toBeDefined()
      expect(read!.patterns.some((pattern) => pattern.endsWith("picture.png"))).toBe(true)
    }),
  )

  it.live("fails when the file does not exist", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const err = yield* fail(dir, { filePath: path.join(dir, "missing.png") })
      expect(err.message).toContain("File not found")
    }),
  )

  it.live("fails for non-image files", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "notes.txt")
      yield* put(filepath, "just text")

      const err = yield* fail(dir, { filePath: filepath })
      expect(err.message).toContain("Unsupported image format")
    }),
  )

  it.live("fails for oversized images", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const filepath = path.join(dir, "big.png")
      yield* put(filepath, Buffer.alloc(11 * 1024 * 1024))

      const err = yield* fail(dir, { filePath: filepath })
      expect(err.message).toContain("Image too large")
    }),
  )
})
