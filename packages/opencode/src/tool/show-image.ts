import { Effect, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import DESCRIPTION from "./show-image.txt"
import { assertExternalDirectoryEffect } from "./external-directory"
import { sniffAttachmentMime } from "@/util/media"

const MAX_BYTES = 10 * 1024 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024 / 1024} MB`
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the image file to display" }),
})

export const ShowImageTool = Tool.define<typeof Parameters, Record<string, any>, FSUtil.Service>(
  "show_image",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service

    const run = Effect.fn("ShowImageTool.execute")(function* (
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
      const title = path.relative(instance.worktree, filepath)

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      yield* assertExternalDirectoryEffect(ctx, filepath, { kind: "file" })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      if (!stat) return yield* Effect.fail(new Error(`File not found: ${filepath}`))
      if (stat.type !== "File") return yield* Effect.fail(new Error(`Not a file: ${filepath}`))
      if (stat.size > MAX_BYTES) {
        return yield* Effect.fail(
          new Error(`Image too large: ${filepath} (${stat.size} bytes, limit ${MAX_BYTES_LABEL})`),
        )
      }

      const bytes = yield* fs.readFile(filepath)
      const mime = sniffAttachmentMime(bytes.subarray(0, 16), FSUtil.mimeType(filepath))
      if (!SUPPORTED_IMAGE_MIMES.has(mime)) {
        return yield* Effect.fail(
          new Error(
            `Unsupported image format: ${mime}. Supported formats: PNG, JPEG, GIF, WebP. Use the read tool to share text-based formats like SVG.`,
          ),
        )
      }

      return {
        title,
        output: `Image displayed to the user: ${filepath}`,
        metadata: {
          preview: path.basename(filepath),
        },
        attachments: [
          {
            type: "file" as const,
            mime,
            filename: path.basename(filepath),
            url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
          },
        ],
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
