export * as SearchIndex from "./search-index"

import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Layer, Schedule, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { MessageTable, PartSearchTextTable, PartTable, SessionTable } from "./sql"
import { SessionV1 } from "../v1/session"
import type { SessionSchema } from "./schema"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export type Source = "user" | "assistant" | "reasoning" | "tools"

export type Field = { source: Source; label: string; text: string }

/** Long tool outputs are truncated in the index; searches beyond this miss. */
const FIELD_LIMIT = 512 * 1024

/** Parts newer than this are re-read on every sync so streaming text stays fresh. */
const REFRESH_WINDOW = 30 * 60 * 1000

export interface Interface {
  /** Brings the index up to date: new parts, changed recent parts, orphan cleanup. */
  sync: (options?: { budget?: number; refresh?: number; sweep?: boolean }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/session/SearchIndex") {}

/**
 * Extracts the searchable text of a part so matches can be labelled and shown
 * with context. Shared by the indexer and the search tool's scan fallback.
 */
export function extractFields(part: SessionV1.Part, role: string | undefined): Field[] {
  switch (part.type) {
    case "text":
      return [{ source: role === "user" ? "user" : "assistant", label: role ?? "text", text: part.text }]
    case "reasoning":
      return [{ source: "reasoning", label: "reasoning", text: part.text }]
    case "subtask":
      return [
        { source: "user", label: "subtask", text: part.prompt },
        { source: "user", label: "subtask description", text: part.description },
      ]
    case "tool": {
      const result: Field[] = [{ source: "tools", label: `tool ${part.tool} input`, text: flatten(part.state.input) }]
      if (part.state.status === "completed")
        result.push({ source: "tools", label: `tool ${part.tool} output`, text: part.state.output })
      if (part.state.status === "error")
        result.push({ source: "tools", label: `tool ${part.tool} error`, text: part.state.error })
      return result
    }
    case "patch":
      return [{ source: "tools", label: "patch files", text: part.files.join("\n") }]
    case "file":
      return [
        {
          source: "tools",
          label: "attached file",
          text: [part.filename, part.url].filter(Boolean).join("\n"),
        },
      ]
    default:
      return []
  }
}

function flatten(input: Record<string, unknown>) {
  return Object.entries(input)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n")
}

type IndexedField = {
  rowid: number
  part_id: string
  ordinal: number
  source: Source
  label: string
  text: string
}

const partSelection = {
  rowid: sql<number>`rowid`,
  id: PartTable.id,
  message_id: PartTable.message_id,
  session_id: PartTable.session_id,
  time_created: PartTable.time_created,
  data: PartTable.data,
}

function rowsToValues(
  rows: {
    rowid: number
    id: SessionV1.PartID
    message_id: SessionV1.MessageID
    session_id: SessionSchema.ID
    time_created: number
    data: unknown
  }[],
  roles: Map<string, string>,
  projects: Map<string, string>,
) {
  return rows.flatMap((row) => {
    const project = projects.get(row.session_id)
    if (!project) return []
    return extractFields(row.data as SessionV1.Part, roles.get(row.message_id)).map((field, ordinal) => ({
      part_rowid: row.rowid,
      part_id: row.id,
      ordinal,
      session_id: row.session_id,
      project_id: project,
      source: field.source,
      label: field.label,
      time_created: row.time_created,
      text: field.text.slice(0, FIELD_LIMIT),
    }))
  })
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size))
  return out
}

const ftsInsert = (tx: Tx, rows: { rowid: number; text: string }[]) => {
  if (rows.length === 0) return Effect.void
  return tx.run(
    sql`INSERT INTO part_search(rowid, text) VALUES ${sql.join(
      rows.map((row) => sql`(${row.rowid}, ${row.text})`),
      sql`, `,
    )}`,
  )
}

const ftsDelete = (tx: Tx, rows: { rowid: number; text: string }[]) => {
  if (rows.length === 0) return Effect.void
  return tx.run(
    sql`INSERT INTO part_search(part_search, rowid, text) VALUES ${sql.join(
      rows.map((row) => sql`('delete', ${row.rowid}, ${row.text})`),
      sql`, `,
    )}`,
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    // drizzle cannot express virtual tables, so the FTS5 index is ensured here;
    // it mirrors part_search_text through external content.
    yield* db
      .run(
        sql`CREATE VIRTUAL TABLE IF NOT EXISTS part_search USING fts5(text, content='part_search_text', content_rowid='rowid', tokenize='trigram')`,
      )
      .pipe(Effect.orDie)

    const lock = Semaphore.makeUnsafe(1)
    const frontierRow = yield* db
      .get<{ frontier: number | null }>(sql`SELECT max(part_rowid) AS frontier FROM part_search_text`)
      .pipe(Effect.orDie)
    let frontier = frontierRow?.frontier ?? 0
    let ticks = 0
    let caughtUp = frontier > 0

    const rolesFor = (messageIDs: SessionV1.MessageID[]) =>
      messageIDs.length === 0
        ? Effect.succeed(new Map<string, string>())
        : db
            .select({ id: MessageTable.id, role: sql<string>`json_extract(${MessageTable.data}, '$.role')` })
            .from(MessageTable)
            .where(inArray(MessageTable.id, messageIDs))
            .all()
            .pipe(Effect.map((rows) => new Map(rows.map((row) => [row.id, row.role]))), Effect.orDie)

    const projectsFor = (sessionIDs: SessionSchema.ID[]) =>
      sessionIDs.length === 0
        ? Effect.succeed(new Map<string, string>())
        : db
            .select({ id: SessionTable.id, project_id: SessionTable.project_id })
            .from(SessionTable)
            .where(inArray(SessionTable.id, sessionIDs))
            .all()
            .pipe(Effect.map((rows) => new Map(rows.map((row) => [row.id, row.project_id]))), Effect.orDie)

    /** Indexes parts never seen before, oldest first. */
    const catchUp = (budget: number) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select(partSelection)
          .from(PartTable)
          .where(sql`rowid > ${frontier}`)
          .orderBy(sql`rowid`)
          .limit(budget)
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 0) {
          if (!caughtUp) {
            caughtUp = true
            yield* Effect.logInfo("session search index caught up")
          }
          return
        }
        const last = rows[rows.length - 1]!.rowid
        const [roles, projects] = yield* Effect.all([
          rolesFor(rows.map((row) => row.message_id)),
          projectsFor(rows.map((row) => row.session_id)),
        ])
        const values = rowsToValues(rows, roles, projects)
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // Another sync loop (a second layer build in this process, or
              // another process sharing the database) may have indexed parts
              // of this range already. Replace its rows so the unique
              // (part_id, ordinal) guard never trips and FTS stays exact.
              const prior = yield* tx
                .select({ rowid: sql<number>`rowid`, text: PartSearchTextTable.text })
                .from(PartSearchTextTable)
                .where(and(gt(PartSearchTextTable.part_rowid, frontier), lte(PartSearchTextTable.part_rowid, last)))
                .all()
                .pipe(Effect.orDie)
              yield* ftsDelete(tx, prior)
              yield* tx.run(
                sql`DELETE FROM part_search_text WHERE part_rowid > ${frontier} AND part_rowid <= ${last}`,
              )
              for (const batch of chunks(values, 400)) yield* tx.insert(PartSearchTextTable).values(batch).run()
              const inserted = yield* tx
                .select({ rowid: sql<number>`rowid`, text: PartSearchTextTable.text })
                .from(PartSearchTextTable)
                .where(and(gt(PartSearchTextTable.part_rowid, frontier), lte(PartSearchTextTable.part_rowid, last)))
                .all()
                .pipe(Effect.orDie)
              yield* ftsInsert(tx, inserted)
            }),
          )
          .pipe(Effect.orDie)
        frontier = last
      })

    /** Re-reads recent parts so text that kept streaming after indexing gets refreshed. */
    const refresh = (budget: number) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select(partSelection)
          .from(PartTable)
          .where(and(gt(PartTable.time_created, Date.now() - REFRESH_WINDOW), sql`rowid <= ${frontier}`))
          .orderBy(desc(PartTable.time_created))
          .limit(budget)
          .all()
          .pipe(Effect.orDie)
        if (rows.length === 0) return
        const [roles, projects] = yield* Effect.all([
          rolesFor(rows.map((row) => row.message_id)),
          projectsFor(rows.map((row) => row.session_id)),
        ])
        const indexed = yield* db
          .select({
            rowid: sql<number>`rowid`,
            part_id: PartSearchTextTable.part_id,
            ordinal: PartSearchTextTable.ordinal,
            source: PartSearchTextTable.source,
            label: PartSearchTextTable.label,
            text: PartSearchTextTable.text,
          })
          .from(PartSearchTextTable)
          .where(inArray(PartSearchTextTable.part_id, rows.map((row) => row.id)))
          .all()
          .pipe(Effect.orDie)
        const kept = new Map<string, IndexedField[]>()
        for (const field of indexed) {
          const list = kept.get(field.part_id) ?? []
          list.push(field)
          kept.set(field.part_id, list)
        }
        const changed = rows.filter((row) => {
          const existing = kept.get(row.id)
          if (!existing) return true
          const fields = extractFields(row.data as SessionV1.Part, roles.get(row.message_id))
          return (
            fields.length !== existing.length ||
            fields.some(
              (field, ordinal) =>
                field.source !== existing[ordinal]!.source ||
                field.label !== existing[ordinal]!.label ||
                field.text.slice(0, FIELD_LIMIT) !== existing[ordinal]!.text,
            )
          )
        })
        if (changed.length === 0) return
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              for (const row of changed) {
                const old = kept.get(row.id) ?? []
                yield* ftsDelete(tx, old)
                yield* tx.delete(PartSearchTextTable).where(eq(PartSearchTextTable.part_id, row.id)).run()
              }
              for (const batch of chunks(rowsToValues(changed, roles, projects), 400))
                yield* tx.insert(PartSearchTextTable).values(batch).run()
              const inserted = yield* tx
                .select({ rowid: sql<number>`rowid`, text: PartSearchTextTable.text })
                .from(PartSearchTextTable)
                .where(inArray(PartSearchTextTable.part_id, changed.map((row) => row.id)))
                .all()
                .pipe(Effect.orDie)
              yield* ftsInsert(tx, inserted)
            }),
          )
          .pipe(Effect.orDie)
      })

    /** Drops index rows whose part is gone, e.g. after session deletion. */
    const sweep = Effect.gen(function* () {
      const orphans = yield* db
        .all<{ rowid: number; text: string }>(
          sql`SELECT s.rowid AS rowid, s.text AS text FROM part_search_text s LEFT JOIN part p ON p.id = s.part_id WHERE p.id IS NULL LIMIT 500`,
        )
        .pipe(Effect.orDie)
      if (orphans.length === 0) return
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* ftsDelete(tx, orphans)
            yield* tx.run(
              sql`DELETE FROM part_search_text WHERE rowid IN (${sql.join(
                orphans.map((row) => sql`${row.rowid}`),
                sql`, `,
              )})`,
            )
          }),
        )
        .pipe(Effect.orDie)
    })

    const sync = (options?: { budget?: number; refresh?: number; sweep?: boolean }) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* catchUp(options?.budget ?? 500)
          yield* refresh(options?.refresh ?? (options?.budget ? 500 : 2000))
          if (options?.sweep) {
            ticks += 1
            if (ticks % 20 === 1) yield* sweep
          }
        }).pipe(
          // Transient SQLite contention (e.g. the boot-time project bootstrap
          // burst) must degrade to a skipped tick, not kill the sync loop.
          Effect.catchCause((cause) =>
            Effect.logError("session search index sync failed", { cause: Cause.pretty(cause) }),
          ),
        ),
      )

    yield* sync({ sweep: true }).pipe(Effect.repeat(Schedule.spaced(Duration.seconds(1))), Effect.forkScoped)

    return Service.of({ sync })
  }),
)

export const node = makeGlobalNode({ name: "session-search-index", layer, deps: [Database.node] })
