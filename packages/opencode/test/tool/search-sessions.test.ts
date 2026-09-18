import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { SearchDatabase } from "@opencode-ai/core/database/search-database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SearchIndex } from "@opencode-ai/core/session/search-index"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Truncate } from "@/tool/truncate"
import { Agent } from "@/agent/agent"
import { SearchSessionsTool } from "../../src/tool/search-sessions"
import { testEffect } from "../lib/effect"
import type * as Tool from "../../src/tool/tool"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([SessionNs.node, SessionProjector.node, SearchIndex.node, SearchDatabase.node, Database.node, Truncate.node, Agent.node]),
  ),
)

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_current_session"),
  messageID: MessageID.make("msg_current"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const run = Effect.fn("SearchSessionsToolTest.run")(function* (
  args: Tool.InferParameters<typeof SearchSessionsTool>,
  next: Tool.Context = ctx,
) {
  const info = yield* SearchSessionsTool
  const tool = yield* info.init()
  return yield* tool.execute(args, next)
})

const addMessage = Effect.fn("SearchSessionsToolTest.addMessage")(function* (
  sessionID: SessionID,
  role: "user" | "assistant",
  parts: Omit<SessionV1.Part, "id" | "sessionID" | "messageID">[],
  parentID?: MessageID,
) {
  const session = yield* SessionNs.Service
  const id = MessageID.ascending()
  yield* session.updateMessage(
    (role === "user"
      ? {
          id,
          sessionID,
          role,
          time: { created: Date.now() },
          agent: "build",
          model: { providerID: "test", modelID: "test" },
          tools: {},
        }
      : {
          id,
          sessionID,
          role,
          time: { created: Date.now() },
          parentID,
          modelID: ModelV2.ID.make("test"),
          providerID: ProviderV2.ID.make("test"),
          mode: "",
          agent: "build",
          path: { cwd: "/", root: "/" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }) as unknown as SessionV1.Info,
  )
  for (const part of parts) {
    yield* session.updatePart({ ...part, id: PartID.ascending(), sessionID, messageID: id } as SessionV1.Part)
  }
  return id
})

const text = (value: string): Omit<SessionV1.TextPart, "id" | "sessionID" | "messageID"> => ({
  type: "text",
  text: value,
})

const tool = (
  name: string,
  input: Record<string, unknown>,
  output: string,
): Omit<SessionV1.ToolPart, "id" | "sessionID" | "messageID"> => ({
  type: "tool",
  callID: `call_${name}`,
  tool: name,
  state: {
    status: "completed",
    input,
    output,
    title: name,
    metadata: {},
    time: { start: 1, end: 2 },
  },
})

describe("tool.search_sessions", () => {
  it.instance("finds text in past sessions of the project", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Fix session status seeding" })
      const ask = yield* addMessage(past.id, "user", [
        text("please make the app seed session statuses across directories"),
      ])
      yield* addMessage(past.id, "assistant", [text("seeded the status map on reconnect")], ask)

      const other = yield* session.create({ title: "Unrelated work" })
      yield* addMessage(other.id, "user", [text("totally different topic")])

      const result = yield* run({ query: "session statuses" })

      expect(result.metadata.matches).toBe(1)
      expect(result.metadata.sessions).toBe(1)
      expect(result.output).toContain("Found 1 matches")
      expect(result.output).toContain(past.id)
      expect(result.output).toContain("Fix session status seeding")
      expect(result.output).toContain("**session statuses**")
      expect(result.output).not.toContain(other.id)
      expect(result.output).not.toContain("totally different topic")
    }),
  )

  it.instance("matches session titles and labels user versus assistant text", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Seeding statuses on reconnect" })
      const ask = yield* addMessage(past.id, "user", [text("seed it")])
      yield* addMessage(past.id, "assistant", [text("the seed routine now runs on reconnect")], ask)

      const result = yield* run({ query: "seed routine" })

      expect(result.output).toContain("[assistant]")
      expect(result.output).not.toContain("title matched")

      const byTitle = yield* run({ query: "seeding statuses" })
      expect(byTitle.output).toContain(past.id)
      expect(byTitle.output).toContain("title matched")
    }),
  )

  it.instance("searches tool inputs and outputs", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Deploy work" })
      const ask = yield* addMessage(past.id, "user", [text("deploy it")])
      yield* addMessage(
        past.id,
        "assistant",
        [tool("bash", { command: "bun run deploy:home" }, "deployed to production")],
        ask,
      )

      const outputs = yield* run({ query: "deployed to production" })
      expect(outputs.output).toContain("[tool bash output]")

      const inputs = yield* run({ query: "deploy:home" })
      expect(inputs.output).toContain("[tool bash input]")
      expect(inputs.output).toContain("**deploy:home**")
    }),
  )

  it.instance("honours the sources filter", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Sources" })
      const ask = yield* addMessage(past.id, "user", [text("run it")])
      yield* addMessage(
        past.id,
        "assistant",
        [text("shared phrase"), tool("bash", { command: "echo" }, "shared phrase")],
        ask,
      )

      const onlyText = yield* run({ query: "shared phrase", sources: ["assistant"] })
      expect(onlyText.metadata.matches).toBe(1)

      const onlyTools = yield* run({ query: "shared phrase", sources: ["tools"] })
      expect(onlyTools.metadata.matches).toBe(1)
      expect(onlyTools.output).toContain("[tool bash output]")
    }),
  )

  it.instance("searches with regular expressions, including alternation and escapes", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Regex" })
      const parent = yield* addMessage(past.id, "user", [text("Abcdef canary")])
      yield* addMessage(past.id, "assistant", [text("nothing to see here")], parent)

      const unicode = yield* run({ query: "\\u0041bcdef", regex: true })
      expect(unicode.metadata.matches).toBe(1)

      const alternation = yield* run({ query: "canary|unrelated-word", regex: true })
      expect(alternation.output).toContain("**canary**")

      const inline = yield* run({ query: "(?i)ABCDEF", regex: true })
      expect(inline.metadata.matches).toBe(1)

      const sequence = yield* run({ query: "Abcdef.*canary", regex: true })
      expect(sequence.metadata.matches).toBe(1)

      // The prefilter must not require text from optional groups, and it must
      // not report matches that the pattern itself rejects.
      const optional = yield* run({ query: "(missing)?canary", regex: true })
      expect(optional.metadata.matches).toBe(1)

      const wrongOrder = yield* run({ query: "canary.*Abcdef", regex: true })
      expect(wrongOrder.metadata.matches).toBe(0)
    }),
  )

  it.instance("keeps literal searches case-insensitive unless asked", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Case" })
      yield* addMessage(past.id, "user", [text("Mixed Case Needle")])

      expect((yield* run({ query: "mixed case needle" })).metadata.matches).toBe(1)
      expect((yield* run({ query: "mixed case needle", case_sensitive: true })).metadata.matches).toBe(0)
      expect((yield* run({ query: "Mixed Case Needle", case_sensitive: true })).metadata.matches).toBe(1)
    }),
  )

  it.instance("skips the current session unless it is named", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const current = yield* session.create({ title: "Current" })
      yield* addMessage(current.id, "user", [text("needle only in the current session")])
      const next: Tool.Context = { ...ctx, sessionID: current.id }

      const without = yield* run({ query: "needle only in the current session" }, next)
      expect(without.metadata.matches).toBe(0)
      expect(without.output).toContain("No matches")

      const withID = yield* run({ query: "needle only in the current session", session_id: current.id }, next)
      expect(withID.metadata.matches).toBe(1)
      expect(withID.output).toContain(current.id)
    }),
  )

  it.instance("rejects regular expressions that cannot be narrowed", () =>
    Effect.gen(function* () {
      const exit = yield* run({ query: "\\d+", regex: true }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }),
  )

  it.instance("reports when nothing matches", () =>
    Effect.gen(function* () {
      yield* SessionNs.Service
      const result = yield* run({ query: "no such text anywhere at all" })
      expect(result.metadata.matches).toBe(0)
      expect(result.output).toContain("No matches")
    }),
  )

  it.instance("caps the number of matches and reports truncation", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Many" })
      for (let index = 0; index < 8; index++) {
        yield* addMessage(past.id, "user", [text(`repeated needle number ${index}`)])
      }

      const result = yield* run({ query: "repeated needle", limit: 3 })
      expect(result.metadata.matches).toBe(3)
      expect(result.metadata.truncated).toBe(true)
      expect(result.output).toContain("Showing 3 of 8 matches")
    }),
  )

  it.instance("falls back to the table scan for queries the trigram index cannot serve", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Short" })
      yield* addMessage(past.id, "user", [text("the qx marker is unique")])

      const result = yield* run({ query: "qx" })
      expect(result.metadata.matches).toBe(1)
      expect(result.output).toContain("**qx**")
    }),
  )

  it.instance("keeps repeated searches stable while the indexer syncs", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Stable" })
      yield* addMessage(past.id, "user", [text("indexing must not duplicate this")])

      const first = yield* run({ query: "indexing must not duplicate" })
      const second = yield* run({ query: "indexing must not duplicate" })
      expect(second.metadata.matches).toBe(first.metadata.matches)
      expect(second.metadata.matches).toBe(1)
    }),
  )

  it.instance("picks up text edited after it was indexed", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Editing" })
      const messageID = yield* addMessage(past.id, "user", [])
      const partID = PartID.ascending()
      const part = { id: partID, sessionID: past.id, messageID, type: "text", text: "original phrasing" } as SessionV1.Part
      yield* session.updatePart(part)

      expect((yield* run({ query: "original phrasing" })).metadata.matches).toBe(1)

      yield* session.updatePart({ ...part, text: "revised phrasing now" })

      expect((yield* run({ query: "revised phrasing now" })).metadata.matches).toBe(1)
      expect((yield* run({ query: "original phrasing" })).metadata.matches).toBe(0)
    }),
  )

  it.instance("drops index rows when a session is deleted", () =>
    Effect.gen(function* () {
      const session = yield* SessionNs.Service
      const past = yield* session.create({ title: "Doomed" })
      yield* addMessage(past.id, "user", [text("ephemeral zebra deletion probe")])

      expect((yield* run({ query: "ephemeral zebra deletion probe" })).metadata.matches).toBe(1)

      const database = yield* Database.Service
      const index = yield* SearchIndex.Service
      const search = yield* SearchDatabase.Service
      yield* database.db.run(sql`DELETE FROM session WHERE id = ${past.id}`)
      yield* index.sync({ sweep: true })

      const remaining = yield* search.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM part_search_text`)
      expect(remaining[0]!.n).toBe(0)
      expect((yield* run({ query: "ephemeral zebra deletion probe" })).metadata.matches).toBe(0)
    }),
  )
})
