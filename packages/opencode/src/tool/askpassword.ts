import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import DESCRIPTION from "./askpassword.txt"

export const Parameters = Schema.Struct({
  title: Schema.String.annotate({
    description: 'What the password is for, shown to the user (e.g. "sudo password for the deploy server")',
  }),
  name: Schema.optional(
    Schema.String.annotate({
      description: 'Short identifier for the stored secret file (letters, numbers, dashes). Defaults to "password".',
    }),
  ),
})

type Metadata = {
  name: string
  path: string
}

const sanitizeName = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "password"

// Keep the secrets directory out of git without touching the user's
// .gitignore: repo-local `.git/info/exclude` entries are not committed.
// Best effort — resolves linked-worktree `.git` pointers to the common dir.
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
      gitDir = target.replace(/[/\\]worktrees[/\\][^/\\]+$/, "")
    }
    if (!gitDir) return
    const rel = path.relative(worktree, directory).split(path.sep).join("/")
    if (!rel) return
    const pattern = `${rel}/`
    const excludePath = path.join(gitDir, "info", "exclude")
    const existing = (yield* fs.readFileStringSafe(excludePath)) ?? ""
    if (existing.split("\n").some((line) => line.trim() === pattern)) return
    const prefix = existing && !existing.endsWith("\n") ? "\n" : ""
    yield* fs.writeFileString(excludePath, `${existing}${prefix}${pattern}\n`)
  }).pipe(Effect.catch(() => Effect.void))

// Non-git instances report worktree "/" (see Project), so prefer the
// instance directory when it is itself a git root.
const gitWorktree = (fs: FSUtil.Interface, ins: { directory: string; worktree?: string }) =>
  Effect.gen(function* () {
    const dotGit = (candidate: string) =>
      fs.stat(path.join(candidate, ".git")).pipe(Effect.catch(() => Effect.succeed(undefined)))
    if ((yield* dotGit(ins.directory)) !== undefined) return ins.directory
    if (ins.worktree && ins.worktree !== "/" && (yield* dotGit(ins.worktree)) !== undefined) return ins.worktree
    return undefined
  })

export const AskPasswordTool = Tool.define<typeof Parameters, Metadata, Question.Service | FSUtil.Service>(
  "askpassword",
  Effect.gen(function* () {
    const question = yield* Question.Service
    const fs = yield* FSUtil.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const name = sanitizeName(params.name ?? "password")
          const dir = path.join(ins.directory, ".opencode", "secrets")
          const file = path.join(dir, name)

          const answers = yield* question
            .ask({
              sessionID: ctx.sessionID,
              questions: [
                {
                  question: params.title,
                  header: "Password",
                  options: [],
                  secret: true,
                },
              ],
              tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
            })
            .pipe(Effect.catchTag("QuestionRejectedError", () => Effect.succeed([[] as string[]])))

          const secret = answers[0]?.[0]
          if (!secret) {
            return {
              title: "Password request dismissed",
              output: "The user dismissed the password prompt. Continue without the secret or ask them how to proceed.",
              metadata: { name, path: file },
            }
          }

          yield* fs.makeDirectory(dir, { recursive: true, mode: 0o700 })
          yield* fs.writeFileString(file, secret)
          yield* fs.chmod(file, 0o600)
          const worktree = yield* gitWorktree(fs, ins)
          if (worktree) yield* ensureGitExclude(fs, worktree, dir)

          const relative = path.relative(ins.directory, file).split(path.sep).join("/")
          return {
            title: "Asked for password",
            output: [
              `The user provided the secret. It is stored in the file \`${relative}\` and was NOT shown to you.`,
              `Use it only through shell redirection or pipes, e.g. \`some-command < ${relative}\` or \`"$(cat ${relative})"\` inside a command that consumes it without printing.`,
              `Never read, print, or grep this file, and never include its contents in command output or in your reply.`,
            ].join(" "),
            metadata: { name, path: file },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
