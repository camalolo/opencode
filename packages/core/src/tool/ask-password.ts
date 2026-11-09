export * as AskPasswordTool from "./ask-password"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { QuestionV2 } from "../question"
import { makeLocationNode } from "../effect/app-node"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "askpassword"

const description = `Securely ask the user for a password or other secret.

The user is prompted with a masked input. The answer is written to a file inside the project and NEVER returned to you, so it never appears in this conversation and is never sent to any model provider.

You receive only the file path. Use the secret exclusively through shell redirection or pipes, for example:
- \`some-command < <path>\`
- \`curl -u user:"$(cat <path>)" ...\`
- \`sudo -S some-command < <path>\`
- \`echo "$(cat <path>)" | docker login -u user --password-stdin\`

NEVER print, read, grep, or expand the file into command output — that would leak the secret into the conversation (e.g. no \`cat <path>\` by itself, no \`set -x\`, no \`echo $SECRET\`). Pass it straight into the consuming command's stdin or an argument substitution that is not printed.

Use one \`name\` per distinct secret (defaults to \`password\`). Asking again with the same name overwrites the stored value; the file persists until overwritten or removed.`

export const Input = Schema.Struct({
  title: Schema.String.annotate({
    description: `What the password is for, shown to the user (e.g. "sudo password for the deploy server")`,
  }),
  name: Schema.optional(
    Schema.String.annotate({
      description: `Short identifier for the stored secret file (letters, numbers, dashes). Defaults to "password".`,
    }),
  ),
})

export const Output = Schema.Struct({
  path: Schema.String,
  provided: Schema.Boolean,
})
export type Output = typeof Output.Type

const sanitizeName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "password"

const modelOutput = (output: Output, relative: string) => {
  if (!output.provided) {
    return "The user dismissed the password prompt. Continue without the secret or ask them how to proceed."
  }
  return [
    `The user provided the secret. It is stored in the file \`${relative}\` and was NOT shown to you.`,
    `Use it only through shell redirection or pipes, e.g. \`some-command < ${relative}\` or \`"$(cat ${relative})"\` inside a command that consumes it without printing.`,
    `Never read, print, or grep this file, and never include its contents in command output or in your reply.`,
  ].join(" ")
}

/**
 * Keep the secrets directory out of git without touching the user's
 * .gitignore: repo-local `.git/info/exclude` entries are not committed. Best
 * effort — resolves linked-worktree `.git` files to the common dir.
 */
const ensureGitExclude = (fs: FSUtil.Interface, worktree: string, directory: string) =>
  Effect.gen(function* () {
    const dotGit = path.join(worktree, ".git")
    const info = yield* fs.stat(dotGit).pipe(Effect.catch(() => Effect.succeed(undefined)))
    let gitDir: string | undefined
    if (info?.type === "Directory") gitDir = dotGit
    if (info?.type === "File") {
      const pointer = yield* fs.readFileString(dotGit)
      const target = pointer?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
      if (!target) return
      const withoutWorktree = target.replace(/[/\\]worktrees[/\\][^/\\]+$/, "")
      gitDir = withoutWorktree
    }
    if (!gitDir) return
    const rel = path.relative(worktree, directory).split(path.sep).join("/")
    const pattern = rel ? `${rel}/` : ""
    if (!pattern) return
    const excludePath = path.join(gitDir, "info", "exclude")
    const existing = (yield* fs.readFileStringSafe(excludePath)) ?? ""
    if (existing.split("\n").some((line) => line.trim() === pattern)) return
    const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
    yield* fs.writeFileString(excludePath, `${existing}${prefix}${pattern}\n`)
  }).pipe(Effect.catch(() => Effect.void))

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const fs = yield* FSUtil.Service
    const question = yield* QuestionV2.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: modelOutput(output, output.path) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              yield* permission
                .assert({
                  action: "question",
                  resources: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                .pipe(Effect.mapError(() => new ToolFailure({ message: "Permission denied: question" })))

              const root = yield* mutation.resolve({ path: "." })
              const name = sanitizeName(input.name ?? "password")
              const file = (yield* mutation.resolve({ path: `.opencode/secrets/${name}` })).canonical
              const dir = path.dirname(file)

              const answers = yield* question
                .ask({
                  sessionID: context.sessionID,
                  questions: [
                    {
                      question: input.title,
                      header: "Password",
                      options: [],
                      secret: true,
                    },
                  ],
                  tool: { messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                .pipe(Effect.catchTag("QuestionV2.RejectedError", () => Effect.succeed([[] as string[]])))

              const secret = answers[0]?.[0]
              if (secret) {
                yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
                yield* fs.writeFileString(file, secret)
                yield* fs.chmod(file, 0o600)
                yield* ensureGitExclude(fs, root.canonical, dir)
              }

              const relative = path.relative(root.canonical, file).split(path.sep).join("/")
              return {
                path: relative,
                provided: Boolean(secret),
              }
            }).pipe(
              Effect.mapError((error) =>
                error instanceof ToolFailure
                  ? error
                  : new ToolFailure({ message: `Unable to store the secret: ${error.message}` }),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/ask-password",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, PermissionV2.node, QuestionV2.node],
})
