import { and, desc, eq, inArray, ne, or, sql, type SQL } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { SearchDatabase } from "@opencode-ai/core/database/search-database"
import { SearchIndex } from "@opencode-ai/core/session/search-index"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import type { SessionV1 } from "@opencode-ai/core/v1/session"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import DESCRIPTION from "./search-sessions.txt"
import * as Tool from "./tool"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description: "Text to look for. With regex: true this is a regular expression.",
  }),
  regex: Schema.optional(Schema.Boolean).annotate({
    description: "Treat query as a regular expression. Defaults to a case-insensitive literal search.",
  }),
  case_sensitive: Schema.optional(Schema.Boolean).annotate({
    description: "Match case exactly. Defaults to false.",
  }),
  session_id: Schema.optional(Schema.String).annotate({
    description: "Only search this session, for example to look deeper after a first search.",
  }),
  scope: Schema.optional(Schema.Literals(["project", "global"])).annotate({
    description: '"project" (default) searches sessions of the current project, "global" searches every session.',
  }),
  sources: Schema.optional(Schema.Array(Schema.Literals(["user", "assistant", "reasoning", "tools"]))).annotate({
    description:
      "Which transcript content to search: user prompts, assistant replies, reasoning, tool calls and outputs. Defaults to all of them.",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Maximum number of matches to return (default 15, max 50).",
  }),
})

type Source = SearchIndex.Source
type Hit = { start: number; length: number }
type PartData = SessionV1.Part
type IndexedRow = { session_id: string; source: Source; label: string; time_created: number; text: string }
type Summary = { id: string; title: string; directory: string; time_updated: number }

const LIKE_ESCAPE = "\u0001"
const SESSION_LIMIT = 10000

export const SearchSessionsTool = Tool.define(
  "search_sessions",
  Effect.gen(function* () {
    const database = yield* Database.Service
    const search = yield* SearchDatabase.Service
    const index = yield* SearchIndex.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const query = params.query.trim()
          if (!query) throw new Error("query is required")
          const limit = Math.min(Math.max(Math.trunc(params.limit ?? 15), 1), 50)
          const caseSensitive = params.case_sensitive ?? false
          const regex = params.regex ?? false
          const sources = params.sources?.length ? new Set<Source>(params.sources) : undefined
          const sessionID = params.session_id ? SessionID.make(params.session_id) : undefined
          const scope = params.scope ?? "project"
          const instance = yield* InstanceState.context
          const match = matcher(query, regex, caseSensitive)
          const clauses = prefilterClauses(query, regex, caseSensitive)
          if (clauses.length === 0)
            throw new Error(
              `The regular expression ${JSON.stringify(query)} has no literal text that every match must contain, ` +
                `so the search cannot be narrowed. Add a literal substring (e.g. "deploy.*failed") or pass session_id.`,
            )

          // Catch up on recently written parts so very fresh sessions are searchable.
          yield* index.sync({ budget: 250 })

          const { db } = database
          const candidateLimit = Math.min(Math.max(limit * 30, 300), 1500)

          // Preferred path: the trigram index narrows candidates in SQLite and
          // the JS matcher below only confirms a few hundred rows. The scan
          // fallback keeps working for queries the trigram index cannot serve
          // (literals under three characters).
          // Ordering by docid (part_search.rowid, which ascends with
          // insertion) lets FTS5 serve the order natively; sorting by
          // time_created instead materializes every match before LIMIT,
          // which measured ~20x slower on common terms for the same recency.
          const fts = ftsQuery(clauses, caseSensitive)
          let hits: Map<string, { label: string; time: number; snippet: string }[]>
          let scanned: number
          if (fts) {
            // An explicit session_id may target the current session; otherwise skip it.
            const conditions: SQL[] = [sql`part_search MATCH ${fts}`]
            if (sessionID) {
              conditions.push(sql`s.session_id = ${sessionID}`)
            } else {
              conditions.push(sql`s.session_id <> ${ctx.sessionID}`)
              if (scope === "project") conditions.push(sql`s.project_id = ${instance.project.id}`)
            }
            if (sources)
              conditions.push(sql`s.source IN (${sql.join([...sources].map((item) => sql`${item}`), sql`, `)})`)
            const rows = yield* search.db
              .all<IndexedRow>(sql`
                SELECT s.session_id AS session_id, s.source AS source, s.label AS label,
                       s.time_created AS time_created, s.text AS text
                FROM part_search
                JOIN part_search_text s ON s.rowid = part_search.rowid
                WHERE ${sql.join(conditions, sql` AND `)}
                ORDER BY part_search.rowid DESC
                LIMIT ${candidateLimit}
              `)
              .pipe(Effect.orDie)
            scanned = rows.length
            hits = new Map()
            for (const row of rows) {
              const hit = match(row.text)
              if (!hit) continue
              const list = hits.get(row.session_id) ?? []
              list.push({ label: row.label, time: row.time_created, snippet: snippet(row.text, hit) })
              hits.set(row.session_id, list)
            }
          } else {
            const filters: SQL[] = [
              and(
                ...clauses.map(
                  (clause) =>
                    or(
                      ...clause.map(
                        (term) =>
                          sql`${PartTable.data} LIKE ${`%${escapeLike(jsonEscape(term))}%`} ESCAPE ${LIKE_ESCAPE}`,
                      ),
                    )!,
                ),
              )!,
            ]
            if (sessionID) filters.push(eq(PartTable.session_id, sessionID))
            else {
              filters.push(ne(PartTable.session_id, ctx.sessionID))
              if (scope === "project")
                filters.push(
                  // Keeping the project as an IN subquery lets SQLite drive the
                  // scan from the project's own parts instead of reading every
                  // stored transcript on the machine.
                  inArray(
                    PartTable.session_id,
                    db
                      .select({ id: SessionTable.id })
                      .from(SessionTable)
                      .where(eq(SessionTable.project_id, instance.project.id)),
                  ),
                )
            }

            // The LIKE prefilter runs inside SQLite and rowid DESC walks newest
            // parts first, so the planner stops scanning once the candidate
            // budget is used up instead of reading every stored transcript.
            const rows = yield* db
              .select()
              .from(PartTable)
              .where(and(...filters))
              .orderBy(sql`rowid DESC`)
              .limit(candidateLimit)
              .all()
              .pipe(Effect.orDie)
            scanned = rows.length

            const messageIDs = [...new Set(rows.map((row) => row.message_id))]
            const roles = new Map<string, string>()
            if (messageIDs.length > 0) {
              const found = yield* db
                .select({
                  id: MessageTable.id,
                  role: sql<string>`json_extract(${MessageTable.data}, '$.role')`,
                })
                .from(MessageTable)
                .where(inArray(MessageTable.id, messageIDs))
                .all()
                .pipe(Effect.orDie)
              for (const row of found) roles.set(row.id, row.role)
            }

            hits = new Map()
            for (const row of rows) {
              for (const field of SearchIndex.extractFields(row.data as PartData, roles.get(row.message_id))) {
                if (sources && !sources.has(field.source)) continue
                const hit = match(field.text)
                if (!hit) continue
                const list = hits.get(row.session_id) ?? []
                list.push({ label: field.label, time: row.time_created, snippet: snippet(field.text, hit) })
                hits.set(row.session_id, list)
              }
            }
          }

          const sessionFilters: SQL[] = []
          if (sessionID) sessionFilters.push(eq(SessionTable.id, sessionID))
          else {
            sessionFilters.push(ne(SessionTable.id, ctx.sessionID))
            if (scope === "project") sessionFilters.push(eq(SessionTable.project_id, instance.project.id))
          }
          const summaries = yield* db
            .select({
              id: SessionTable.id,
              title: SessionTable.title,
              directory: SessionTable.directory,
              time_updated: SessionTable.time_updated,
            })
            .from(SessionTable)
            .where(and(...sessionFilters))
            .orderBy(desc(SessionTable.time_updated))
            .limit(SESSION_LIMIT)
            .all()
            .pipe(Effect.orDie)

          const titleMatches = new Set(summaries.filter((row) => match(row.title)).map((row) => row.id))
          // Keep a few matches per session so one busy session cannot fill the
          // whole result, but stay deep when only one or two sessions matched.
          const matched = summaries.filter((row) => hits.has(row.id) || titleMatches.has(row.id)).length
          const perSession = Math.max(3, Math.ceil(limit / Math.max(1, Math.min(matched, 3))))
          const shown: (Summary & { titleMatch: boolean; hits: { label: string; time: number; snippet: string }[] })[] =
            []
          let count = 0
          let dropped = false
          for (const summary of summaries) {
            const group = hits.get(summary.id)?.toSorted((a, b) => a.time - b.time) ?? []
            const titleMatch = titleMatches.has(summary.id)
            if (group.length === 0 && !titleMatch) continue
            const selected = group.slice(0, Math.min(Math.max(0, limit - count), perSession))
            if (selected.length < group.length) dropped = true
            if (selected.length === 0 && !titleMatch) continue
            shown.push({ ...summary, titleMatch, hits: selected })
            count += selected.length
          }

          const candidates = scanned >= candidateLimit
          const total = [...hits.values()].reduce((sum, list) => sum + list.length, 0)
          const lines: string[] = []
          if (shown.length === 0)
            lines.push(
              `No matches for ${JSON.stringify(query)} (${scope} scope, ${scanned} transcript parts scanned).`,
            )
          else {
            const action = dropped ? `Showing ${count} of ${total} matches` : `Found ${count} matches`
            lines.push(
              `${action} in ${shown.length} ${shown.length === 1 ? "session" : "sessions"} for ${JSON.stringify(query)} (${scope} scope)`,
            )
            for (const group of shown) {
              lines.push(
                "",
                `${group.id} · ${group.title}`,
                `${group.directory} · updated ${timestamp(group.time_updated)}${group.titleMatch ? " · title matched" : ""}`,
              )
              for (const hit of group.hits) lines.push(`  [${hit.label}] ${timestamp(hit.time)} ${hit.snippet}`)
            }
          }
          if (candidates)
            lines.push(
              "",
              `(Scan stopped after ${candidateLimit} transcript parts. Use a more specific query or a session_id for deeper results.)`,
            )

          return {
            title: params.query,
            metadata: { matches: count, sessions: shown.length, truncated: candidates || dropped },
            output: lines.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)

/** Builds the test function for one query, returning the first match in a text. */
function matcher(query: string, regex: boolean, caseSensitive: boolean) {
  if (regex) {
    const pattern = compile(query, caseSensitive)
    return (text: string): Hit | undefined => {
      pattern.lastIndex = 0
      const found = pattern.exec(text)
      return found ? { start: found.index, length: found[0].length } : undefined
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  return (text: string): Hit | undefined => {
    const start = (caseSensitive ? text : text.toLowerCase()).indexOf(needle)
    return start === -1 ? undefined : { start, length: needle.length }
  }
}

function compile(query: string, caseSensitive: boolean) {
  const inline = /^\(\?([ims]+)\)/.exec(query)
  const flags = new Set(caseSensitive ? [] : ["i"])
  if (inline) for (const flag of inline[1]) flags.add(flag)
  try {
    return new RegExp(inline ? query.slice(inline[0].length) : query, [...flags, "g"].join(""))
  } catch (error) {
    throw new Error(
      `Invalid regular expression ${JSON.stringify(query)}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

/**
 * Literal text for the SQL LIKE prefilter, as clauses that all must match
 * while the literals inside one clause are alternatives. Regex queries need
 * this because the part table is far too large to test every row in JS.
 */
function prefilterClauses(query: string, regex: boolean, caseSensitive: boolean) {
  const clauses = regex ? requiredLiterals(query) : [[query]]
  return clauses.map((clause) => [
    ...new Set(
      clause.flatMap((literal) =>
        // LIKE already folds ASCII case; only non-ASCII letters need variants.
        caseSensitive || !/[^\x00-\x7F]/.test(literal)
          ? [literal]
          : [literal, literal.toLowerCase(), literal.toUpperCase()],
      ),
    ),
  ])
}

type Branch = { clauses: string[][] }
type Group = { branches: Branch[]; lookaround: boolean }

/**
 * Collects literal substrings that every match of a regular expression must
 * contain: `foo.*bar` yields both words, `foo|bar` yields either, while
 * `(abc)?d` yields only `d`. Returns clauses of alternatives; every clause has
 * to match. An empty list means the pattern cannot be narrowed at all.
 */
function requiredLiterals(source: string): string[][] {
  const groups: Group[] = [{ branches: [{ clauses: [] }], lookaround: false }]
  const branch = () => {
    const group = groups[groups.length - 1]!
    return group.branches[group.branches.length - 1]!
  }
  let run = ""
  const flush = (required: boolean) => {
    if (!run) return
    if (required) branch().clauses.push([run])
    run = ""
  }
  let index = 0
  while (index < source.length) {
    const char = source[index]!
    if (char === "\\") {
      const escape = readEscape(source, index)
      if (escape.literal === undefined) flush(true)
      else run += escape.literal
      index = escape.next
      continue
    }
    if (char === "[") {
      flush(true)
      index = skipClass(source, index)
      continue
    }
    if (char === "(") {
      const start = groupStart(source, index)
      if (start.standalone) {
        index = start.content
        continue
      }
      flush(true)
      groups.push({ branches: [{ clauses: [] }], lookaround: start.lookaround })
      index = start.content
      continue
    }
    if (char === ")") {
      flush(true)
      const closed = groups.length > 1 ? groups.pop() : undefined
      const quantifier = quantifierAt(source, index + 1)
      if (closed) mergeGroup(branch(), closed, quantifier?.optional ?? false)
      index += 1 + (quantifier?.length ?? 0)
      continue
    }
    if (char === "|") {
      flush(true)
      groups[groups.length - 1]!.branches.push({ clauses: [] })
      index += 1
      continue
    }
    const quantifier =
      char === "*" || char === "?" || char === "+" || char === "{" ? quantifierAt(source, index) : undefined
    if (quantifier) {
      flush(!quantifier.optional)
      index += quantifier.length
      continue
    }
    if (".^${}]".includes(char)) {
      flush(true)
      index += 1
      continue
    }
    run += char
    index += 1
  }
  flush(true)

  const root = groups[0]
  if (!root) return []
  // A match satisfies one of the top level branches, so alternatives cannot be
  // combined unless every branch is guaranteed to contribute a literal.
  if (root.branches.length === 1) return root.branches[0]!.clauses
  if (root.branches.some((item) => item.clauses.length === 0)) return []
  return [root.branches.flatMap((item) => item.clauses.flat())]
}

/** Folds a closed group into its parent branch, dropping anything not required. */
function mergeGroup(parent: Branch, group: Group, optional: boolean) {
  // Lookarounds assert but do not consume text, and optional groups may be skipped.
  if (group.lookaround || optional) return
  if (group.branches.some((item) => item.clauses.length === 0)) return
  if (group.branches.length === 1) {
    parent.clauses.push(...group.branches[0]!.clauses)
    return
  }
  parent.clauses.push(group.branches.flatMap((item) => item.clauses.flat()))
}

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", f: "\f", v: "\v" }

/** Reads the escape at `\` and returns where it ends, plus any literal it stands for. */
function readEscape(source: string, index: number): { next: number; literal?: string } {
  const char = source[index + 1]
  if (char === undefined) return { next: source.length }
  // Shorthand classes, anchors, and backreferences are not literal text.
  if (/[dDwWsSbBAZzG]/.test(char)) return { next: index + 2 }
  if (char === "k") {
    const end = source.indexOf(">", index + 2)
    return { next: end === -1 ? index + 2 : end + 1 }
  }
  if (char === "u" || char === "x") {
    if (source[index + 2] === "{") {
      const end = source.indexOf("}", index + 3)
      return { next: end === -1 ? index + 3 : end + 1 }
    }
    const digits = /^[0-9a-fA-F]+/.exec(source.slice(index + 2))
    return { next: index + 2 + Math.min(digits?.[0].length ?? 0, char === "x" ? 2 : 4) }
  }
  if (char === "p" || char === "P") {
    const end = source.indexOf("}", index + 2)
    return { next: end === -1 ? index + 2 : end + 1 }
  }
  if (/[0-9c]/.test(char)) return { next: index + 2 }
  return { next: index + 2, literal: ESCAPES[char] ?? char }
}

/** Reads the group header at `(` and returns where the group content starts. */
function groupStart(source: string, index: number): { content: number; lookaround: boolean; standalone: boolean } {
  if (source[index + 1] !== "?") return { content: index + 1, lookaround: false, standalone: false }
  const marker = source[index + 2]
  if (marker === "<") {
    const next = source[index + 3]
    if (next === "=" || next === "!") return { content: index + 4, lookaround: true, standalone: false }
    const name = source.indexOf(">", index + 3)
    return { content: name === -1 ? index + 3 : name + 1, lookaround: false, standalone: false }
  }
  if (marker === "=" || marker === "!") return { content: index + 3, lookaround: true, standalone: false }
  if (marker === ":") return { content: index + 3, lookaround: false, standalone: false }
  // Inline flags swallow no characters: `(?i)` ends the group, `(?i:x)` opens one.
  const flags = /^\(\?[a-z]+([:)]?)/.exec(source.slice(index))
  if (!flags) return { content: index + 2, lookaround: false, standalone: false }
  return flags[1] === ":"
    ? { content: index + flags[0].length, lookaround: false, standalone: false }
    : { content: index + flags[0].length, lookaround: false, standalone: true }
}

function skipClass(source: string, index: number) {
  let cursor = index + 1
  if (source[cursor] === "^") cursor += 1
  if (source[cursor] === "]") cursor += 1
  while (cursor < source.length) {
    if (source[cursor] === "\\") {
      cursor += 2
      continue
    }
    if (source[cursor] === "]") return cursor + 1
    cursor += 1
  }
  return cursor
}

function quantifierAt(source: string, index: number): { optional: boolean; length: number } | undefined {
  const char = source[index]
  if (char === "?" || char === "*") return { optional: true, length: 1 }
  if (char === "+") return { optional: false, length: 1 }
  if (char !== "{") return
  const match = /^\{(\d*)(,(\d*))?\}/.exec(source.slice(index))
  if (!match) return
  return { optional: (match[1] ? Number(match[1]) : 0) === 0, length: match[0].length }
}

/**
 * Builds the FTS5 MATCH expression for the trigram index: one group of
 * alternative phrases per required clause, joined by AND. Returns undefined
 * when some literal is shorter than three code points, because the trigram
 * tokenizer cannot represent it, in which case the caller falls back to the
 * table scan. The JS matcher stays authoritative for case and regex details;
 * the index only narrows candidates.
 */
function ftsQuery(clauses: string[][], caseSensitive: boolean): string | undefined {
  const groups: string[] = []
  for (const clause of clauses) {
    const terms = new Set<string>()
    for (const literal of clause) {
      if ([...literal].length < 3) return undefined
      for (const variant of caseVariants(literal, caseSensitive)) terms.add(variant)
    }
    groups.push(`(${[...terms].map(ftsPhrase).join(" OR ")})`)
  }
  return groups.join(" AND ")
}

/** LIKE already folds ASCII case; only non-ASCII letters need explicit variants. */
function caseVariants(literal: string, caseSensitive: boolean) {
  return caseSensitive || !/[^\x00-\x7F]/.test(literal) ? [literal] : [literal, literal.toLowerCase(), literal.toUpperCase()]
}

function ftsPhrase(literal: string) {
  return `"${literal.replaceAll('"', '""')}"`
}

/** One highlighted line around the match, with whitespace collapsed. */
function snippet(text: string, hit: Hit, width = 220) {
  const pad = Math.max(0, Math.floor((width - hit.length) / 2))
  const from = Math.max(0, hit.start - pad)
  const to = Math.min(text.length, hit.start + hit.length + pad)
  const before = text.slice(from, hit.start).replace(/\s+/g, " ")
  const found = text.slice(hit.start, hit.start + hit.length).replace(/\s+/g, " ")
  const after = text.slice(hit.start + hit.length, to).replace(/\s+/g, " ")
  return `${from > 0 ? "…" : ""}${before}**${found}**${after}${to < text.length ? "…" : ""}`
}

function timestamp(millis: number) {
  const date = new Date(millis)
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function escapeLike(value: string) {
  return value.replace(/[%_\u0001]/g, (char) => LIKE_ESCAPE + char)
}

/** How a literal appears inside the JSON stored in the part table. */
function jsonEscape(value: string) {
  return JSON.stringify(value).slice(1, -1)
}
