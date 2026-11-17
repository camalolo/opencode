import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { MessageID, PartID } from "@opencode-ai/core/v1/session"
import { ToolRanking } from "@/tool/ranking"
import { tmpdir } from "../fixture/fixture"
import { pollWithTimeout } from "../lib/effect"

const DAY = 24 * 60 * 60 * 1000

const seed = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    const insert = (sessionID: string, directory: string, messageID: string, time: number, parts: unknown[]) =>
      Effect.gen(function* () {
        yield* db
          .insert(ProjectTable)
          .values({
            id: ProjectV2.ID.make(`prj_${sessionID}`),
            worktree: AbsolutePath.make("/tmp/ranking"),
            name: "ranking",
            sandboxes: [],
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionTable)
          .values({
            id: SessionSchema.ID.make(sessionID),
            project_id: ProjectV2.ID.make(`prj_${sessionID}`),
            slug: sessionID,
            directory: AbsolutePath.make(directory),
            title: sessionID,
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(MessageTable)
          .values({ id: MessageID.make(messageID), session_id: SessionSchema.ID.make(sessionID), data: { role: "user" } as never })
          .run()
          .pipe(Effect.orDie)
        for (const [index, data] of parts.entries()) {
          yield* db
            .insert(PartTable)
            .values({
              id: PartID.make(`prt_${messageID}_${index}`),
              message_id: MessageID.make(messageID),
              session_id: SessionSchema.ID.make(sessionID),
              data: data as never,
              time_created: time,
            })
            .run()
            .pipe(Effect.orDie)
        }
      })

    const now = Date.now()
    yield* insert("ses_a", "/work/a", "msg_a", now, [
      { type: "tool", tool: "google-workspace_search_emails" },
      { type: "tool", tool: "google-workspace_search_emails" },
      { type: "tool", tool: "execute", metadata: { toolCalls: [{ tool: "google-workspace.send_email" }] } },
      { type: "text", text: "not a tool part" },
      { type: "tool", tool: "google-workspace_delete_file" },
    ])
    yield* insert("ses_b", "/work/b", "msg_b", now, [
      { type: "tool", tool: "google-workspace_send_email" },
    ])
    // Outside the trailing window.
    yield* insert("ses_old", "/work/a", "msg_old", now - 100 * DAY, [
      { type: "tool", tool: "google-workspace_stale_tool" },
    ])
  })

const TEST_TIMEOUT = 30_000

describe("ToolRanking", () => {
  test(
    "counts tool parts per directory with a global fallback",
    async () => {
      await using tmp = await tmpdir()
      const filename = `${tmp.path}/ranking.sqlite`
      await Effect.gen(function* () {
        const database = yield* Database.Service
        yield* seed(database.db)

        const ranking = yield* ToolRanking.Service
        const counts = yield* pollWithTimeout(
          ranking.counts("/work/a").pipe(Effect.map((counts) => (counts.size > 0 ? counts : undefined))),
          "tool usage scan never populated",
        )

        expect(counts.get("google-workspace_search_emails")).toBe(2)
        expect(counts.get("google-workspace.send_email")).toBe(1)
        expect(counts.get("google-workspace_delete_file")).toBe(1)
        expect(counts.get("google-workspace_send_email")).toBeUndefined()
        expect(counts.get("google-workspace_stale_tool")).toBeUndefined()

        const global = yield* ranking.counts("/work/unknown")
        expect(global.get("google-workspace_search_emails")).toBe(2)
        expect(global.get("google-workspace_send_email")).toBe(1)
        expect(global.get("google-workspace_send_email")! + global.get("google-workspace.send_email")!).toBe(2)
      }).pipe(
        Effect.provide(
          LayerNode.compile(
            LayerNode.group([ToolRanking.node, Database.node]),
            [[Database.node, Database.layerFromPath(filename)]],
          ),
        ),
        Effect.scoped,
        Effect.runPromise,
      )
    },
    TEST_TIMEOUT,
  )
})
