import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./send-file-to-user.txt"
import { containsPath } from "../project/instance-context"

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to send to the user" }),
})

// type alias (not interface) so it satisfies Tool's `{ [key: string]: any }` metadata constraint
export type SendFileMetadata = {
  path: string
  filename: string
  mime: string
  size: number
  download: boolean
}

export const SendFileToUserTool = Tool.define<typeof Parameters, SendFileMetadata, FSUtil.Service>(
  "send_file_to_user",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const run = Effect.fn("SendFileToUserTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = FSUtil.normalizePath(filepath)
      }

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* Effect.fail(new Error(`File not found: ${filepath}`))
      if (stat.type !== "File") return yield* Effect.fail(new Error(`Not a file: ${filepath}`))
      if (!containsPath(filepath, instance)) {
        return yield* Effect.fail(
          new Error(
            `File is outside the project: ${filepath}. Downloads only serve files inside the project; write generated files into the project worktree first.`,
          ),
        )
      }

      const title = path.relative(instance.worktree, filepath)
      const filename = path.basename(filepath)
      const mime = FSUtil.mimeType(filepath)

      return {
        title,
        output: `File sent to the user's browser as a download: ${filename}. Tell the user it is ready.`,
        metadata: {
          path: filepath,
          filename,
          mime,
          size: Number(stat.size),
          download: true,
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
