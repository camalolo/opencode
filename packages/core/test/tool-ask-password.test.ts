import fs from "fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { AskPasswordTool } from "@opencode-ai/core/tool/ask-password"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_ask_password_tool_test")
const assertions: PermissionV2.AssertInput[] = []
let captured: QuestionV2.AskInput | undefined
let reject = false

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => assertions.push(input)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const question = Layer.succeed(
  QuestionV2.Service,
  QuestionV2.Service.of({
    ask: (input: QuestionV2.AskInput) =>
      Effect.sync(() => {
        captured = input
      }).pipe(Effect.andThen(reject ? Effect.fail(new QuestionV2.RejectedError()) : Effect.succeed([["hunter2"]])))!,
    reply: () => Effect.die("unused"),
    reject: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const withTool = <A, E, R>(directory: string, body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LocationMutation.node, AskPasswordTool.node]),
        [
          [
            Location.node,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ],
          [PermissionV2.node, permission],
          [QuestionV2.node, question],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )

const call = (input: typeof AskPasswordTool.Input.Type, id = "call-ask-password") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "askpassword", input },
})

const reset = () => {
  assertions.length = 0
  captured = undefined
  reject = false
}

const it = testEffect(Layer.empty)

describe("AskPasswordTool", () => {
  it.live("stores the secret in the location and never returns it to the model", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["askpassword"])

            const settlement = yield* settleTool(registry, call({ title: "Deploy password", name: "Deploy Host!" }))
            expect(settlement.result).toEqual({
              type: "text",
              value: expect.not.stringContaining("hunter2"),
            })
            expect(settlement.output?.structured).toEqual({ path: ".opencode/secrets/deploy-host", provided: true })
            expect(JSON.stringify(settlement)).not.toContain("hunter2")

            const stored = yield* Effect.promise(() => fs.readFile(`${tmp.path}/.opencode/secrets/deploy-host`, "utf8"))
            expect(stored).toBe("hunter2")
            if (process.platform !== "win32") {
              const stat = yield* Effect.promise(() => fs.stat(`${tmp.path}/.opencode/secrets/deploy-host`))
              const dirStat = yield* Effect.promise(() => fs.stat(`${tmp.path}/.opencode/secrets`))
              expect(stat.mode & 0o777).toBe(0o600)
              expect(dirStat.mode & 0o777).toBe(0o700)
            }
            expect(captured?.questions).toEqual([
              { question: "Deploy password", header: "Password", options: [], secret: true },
            ])
            expect(assertions).toMatchObject([{ sessionID, action: "question", resources: ["*"] }])
          }),
        )
      },
      (_tmp) => Effect.void,
    ),
  )

  it.live("defaults the stored name and marks dismissed prompts as not provided", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            const settlement = yield* settleTool(registry, call({ title: "Sudo password" }, "call-default-name"))
            expect(settlement.output?.structured).toEqual({ path: ".opencode/secrets/password", provided: true })

            reject = true
            const dismissed = yield* settleTool(registry, call({ title: "Sudo password" }, "call-dismissed"))
            expect(dismissed.output?.structured).toEqual({ path: ".opencode/secrets/password", provided: false })
            expect(dismissed.result).toEqual({
              type: "text",
              value: "The user dismissed the password prompt. Continue without the secret or ask them how to proceed.",
            })
            const stored = yield* Effect.promise(() => fs.readFile(`${tmp.path}/.opencode/secrets/password`, "utf8"))
            expect(stored).toBe("hunter2")
          }),
        )
      },
      (_tmp) => Effect.void,
    ),
  )

  it.live("keeps the secrets directory out of git without touching .gitignore", () =>
    Effect.acquireUseRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => {
        reset()
        return withTool(tmp.path, (registry) =>
          Effect.gen(function* () {
            yield* Effect.promise(async () => {
              await fs.mkdir(`${tmp.path}/.git/info`, { recursive: true })
              await fs.writeFile(`${tmp.path}/.git/info/exclude`, "# manually ignored\nignored.txt\n")
              await fs.writeFile(`${tmp.path}/.gitignore`, "node_modules\n")
            })

            yield* settleTool(registry, call({ title: "Deploy password" }, "call-git-exclude"))

            const exclude = yield* Effect.promise(() => fs.readFile(`${tmp.path}/.git/info/exclude`, "utf8"))
            expect(exclude).toBe("# manually ignored\nignored.txt\n.opencode/secrets/\n")
            const gitignore = yield* Effect.promise(() => fs.readFile(`${tmp.path}/.gitignore`, "utf8"))
            expect(gitignore).toBe("node_modules\n")

            yield* settleTool(registry, call({ title: "Deploy password" }, "call-git-exclude-again"))
            const excludeAfterRepeat = yield* Effect.promise(() => fs.readFile(`${tmp.path}/.git/info/exclude`, "utf8"))
            expect(excludeAfterRepeat).toBe("# manually ignored\nignored.txt\n.opencode/secrets/\n")
          }),
        )
      },
      (_tmp) => Effect.void,
    ),
  )
})
