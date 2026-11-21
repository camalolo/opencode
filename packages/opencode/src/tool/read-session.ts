import { asc, eq, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID } from "@/session/schema"
import DESCRIPTION from "./read-session.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  session_id: Schema.String.annotate({
    description: "Session to read, for example an id from search_sessions results. The current session's id is allowed.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description:
      "Only include turns whose shown content contains this text. With regex: true this is a regular expression.",
  }),
  regex: Schema.optional(Schema.Boolean).annotate({
    description: "Treat query as a regular expression. Defaults to a case-insensitive literal search.",
  }),
  case_sensitive: Schema.optional(Schema.Boolean).annotate({
    description: "Match case exactly. Defaults to false.",
  }),
  sources: Schema.optional(Schema.Array(Schema.Literals(["user", "assistant", "reasoning", "tools"]))).annotate({
    description:
      'Which content to show: "user" prompts, "assistant" replies, "reasoning", and tool calls/outputs ("tools"). Defaults to user and assistant text.',
  }),
  after: Schema.optional(Schema.Number).annotate({
    description: "Start at this 1-based turn number to page through a long transcript.",
  }),
})

type Source = "user" | "assistant" | "reasoning" | "tools"
type Hit = { start: number; length: number }
type Block = { source: Source; label?: string; text: string }
type Turn = { index: number; role: string; time: number; blocks: Block[] }

/** Byte budget for rendered turns; the generic tool truncation (50KB) stays as a safety net. */
const TURN_BUDGET = 45_000

const SOURCES: Source[] = ["user", "assistant", "reasoning", "tools"]
const DEFAULT_SOURCES: Source[] = ["user", "assistant"]

export const ReadSessionTool = Tool.define(
  "read_session",
  Effect.gen(function* () {
    const database = yield* Database.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>) =>
        Effect.gen(function* () {
          const sessionID = SessionID.make(params.session_id)
          const query = params.query?.trim()
          if (params.query && !query) throw new Error("query must not be empty when provided")
          const sources = new Set<Source>(params.sources?.length ? params.sources : DEFAULT_SOURCES)
          const after = Number.isFinite(params.after) ? Math.max(1, Math.trunc(params.after!)) : 1
          const match = query ? matcher(query, params.regex ?? false, params.case_sensitive ?? false) : undefined

          const { db } = database
          const summary = yield* db
            .select({
              id: SessionTable.id,
              title: SessionTable.title,
              directory: SessionTable.directory,
              time_updated: SessionTable.time_updated,
            })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get()
            .pipe(Effect.orDie)
          if (!summary)
            throw new Error(`Session not found: ${params.session_id}. Run search_sessions to find session ids.`)

          const messages = yield* db
            .select({
              id: MessageTable.id,
              role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
              time_created: MessageTable.time_created,
            })
            .from(MessageTable)
            .where(eq(MessageTable.session_id, sessionID))
            .orderBy(asc(MessageTable.time_created), asc(MessageTable.id))
            .all()
            .pipe(Effect.orDie)
          const parts = messages.length
            ? yield* db
                .select({ message_id: PartTable.message_id, data: PartTable.data })
                .from(PartTable)
                .where(eq(PartTable.session_id, sessionID))
                .orderBy(asc(PartTable.message_id), asc(PartTable.id))
                .all()
                .pipe(Effect.orDie)
            : []

          const byMessage = new Map<string, SessionV1.Part[]>()
          for (const row of parts) {
            const list = byMessage.get(row.message_id) ?? []
            list.push(row.data as SessionV1.Part)
            byMessage.set(row.message_id, list)
          }
          const turns: Turn[] = messages.map((message, index) => ({
            index: index + 1,
            role: message.role,
            time: message.time_created,
            blocks: blocksFor(message.role, byMessage.get(message.id) ?? []),
          }))
          const last = turns[turns.length - 1]?.index ?? 0

          const content = (turn: Turn) =>
            renderBlocks(turn.blocks.filter((block) => sources.has(block.source)))
          const inWindow = turns.filter((turn) => turn.index >= after && content(turn) !== "")
          const matched = match ? inWindow.filter((turn) => match(content(turn))) : inWindow

          const lines: string[] = [
            `${summary.id} · ${summary.title}`,
            `${summary.directory} · updated ${timestamp(summary.time_updated)}`,
            `Each [turn N · role · time] header starts one message and the lines below it are its content. ` +
              `Turn numbers count every message in the session. ` +
              `Content is verbatim; a content line that would look like a header gets one leading space.`,
          ]
          let shownCount = 0
          if (matched.length === 0) {
            lines.push(
              query
                ? `No turns matched ${JSON.stringify(query)} (${describeSources(sources)}, ${turns.length} turns scanned).`
                : `No readable turns (${describeSources(sources)}).`,
            )
            if (query && sources.size < SOURCES.length) {
              const found = new Set(
                inWindow.flatMap((turn) =>
                  turn.blocks.filter((block) => match!(renderBlocks([block]))).map((block) => block.source),
                ),
              )
              if (found.size > 0)
                lines.push(
                  `Matches exist under content: ${[...found].join(", ")}. Re-run with sources: ${JSON.stringify(
                    SOURCES.filter((source) => found.has(source)),
                  )} to include them.`,
                )
            }
          } else {
            const shown: string[] = []
            let bytes = 0
            let next: Turn | undefined
            for (let index = 0; index < matched.length; index++) {
              const turn = matched[index]
              const rendered = renderTurn(turn, content(turn))
              const size = Buffer.byteLength(rendered, "utf-8")
              if (bytes > 0 && bytes + size > TURN_BUDGET) {
                next = turn
                break
              }
              if (size > TURN_BUDGET) {
                shown.push(renderTruncated(turn, rendered, size))
                next = matched[index + 1]
                break
              }
              shown.push(rendered)
              bytes += size
            }
            shownCount = shown.length
            lines.push(
              `Showing ${shown.length} of ${turns.length} turns${query ? ` matching ${JSON.stringify(query)}` : ""} (${describeSources(sources)}).`,
              "",
              ...shown.flatMap((rendered) => [rendered, ""]),
            )
            if (next) lines.push(`[Turns ${next.index}-${last} not shown. Re-run with after=${next.index} for the next page.]`)
          }

          return {
            title: summary.title,
            metadata: { session: summary.id, turns: turns.length, shown: shownCount },
            output: lines.join("\n").trimEnd(),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/** One labeled block per content piece, mirroring the labels search_sessions uses. */
function blocksFor(role: string | undefined, parts: SessionV1.Part[]): Block[] {
  const result: Block[] = []
  for (const part of parts) {
    switch (part.type) {
      case "text":
        if (part.ignored || part.text === "") break
        result.push({ source: role === "user" ? "user" : "assistant", text: part.text })
        break
      case "reasoning":
        result.push({ source: "reasoning", label: "reasoning", text: part.text })
        break
      case "subtask":
        result.push({ source: "user", label: `subtask ${part.description}`, text: part.prompt })
        break
      case "file":
        result.push({ source: "user", label: `attachment ${part.filename ?? part.mime}`, text: "" })
        break
      case "tool": {
        result.push({ source: "tools", label: `tool ${part.tool} input`, text: flattenInput(part.state.input) })
        if (part.state.status === "completed")
          result.push({ source: "tools", label: `tool ${part.tool} output`, text: part.state.output })
        if (part.state.status === "error")
          result.push({ source: "tools", label: `tool ${part.tool} error`, text: part.state.error })
        break
      }
      case "patch":
        result.push({ source: "tools", label: "patch files", text: part.files.join("\n") })
        break
    }
  }
  return result
}

function flattenInput(input: Record<string, unknown>) {
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n")
}

/** Content is plain text: no control characters, no padding, and header look-alikes indented. */
function sanitize(text: string) {
  const clean = text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "")
  return clean
    .split("\n")
    .map((line) => (/^\[(turn \d+|reasoning|tool |subtask|attachment|patch files)/.test(line) ? ` ${line}` : line))
    .join("\n")
}

function renderBlocks(blocks: Block[]) {
  return blocks
    .map((block) => {
      const body = sanitize(block.text)
      if (!block.label) return body
      return body ? `[${block.label}]\n${body}` : `[${block.label}]`
    })
    .join("\n\n")
}

function renderTurn(turn: Turn, body: string) {
  const header = `[turn ${turn.index} · ${turn.role} · ${timestamp(turn.time)}]`
  return body ? `${header}\n${body}` : header
}

function renderTruncated(turn: Turn, body: string, size: number) {
  const head = Buffer.from(body, "utf-8").subarray(0, TURN_BUDGET).toString("utf-8")
  return renderTurn(turn, `${head}\n[turn content truncated: showing the first ${TURN_BUDGET} of ${size} bytes. Narrow with query or sources.]`)
}

function describeSources(sources: Set<Source>) {
  return `content: ${SOURCES.filter((source) => sources.has(source)).join(", ")}`
}

/** Builds the test function for one query, returning the first match in a text. */
function matcher(query: string, regex: boolean, caseSensitive: boolean) {
  if (!regex) {
    const needle = caseSensitive ? query : query.toLowerCase()
    return (text: string): Hit | undefined => {
      const start = (caseSensitive ? text : text.toLowerCase()).indexOf(needle)
      return start === -1 ? undefined : { start, length: needle.length }
    }
  }
  const inline = /^\(\?([ims]+)\)/.exec(query)
  const flags = new Set(caseSensitive ? [] : ["i"])
  if (inline) for (const flag of inline[1]) flags.add(flag)
  const pattern = new RegExp(inline ? query.slice(inline[0].length) : query, [...flags, "g"].join(""))
  return (text: string): Hit | undefined => {
    pattern.lastIndex = 0
    const found = pattern.exec(text)
    return found ? { start: found.index, length: found[0].length } : undefined
  }
}

function timestamp(millis: number) {
  const date = new Date(millis)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export * as ReadSession from "./read-session"
