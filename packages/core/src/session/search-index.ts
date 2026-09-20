export * as SearchIndex from "./search-index"

import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm"
import { Cause, Context, Duration, Effect, Exit, Layer, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Database } from "../database/database"
import { SearchDatabase, PartSearchTextTable } from "../database/search-database"
import { makeGlobalNode } from "../effect/app-node"
import { MessageTable, PartTable, SessionTable } from "./sql"
import { SessionV1 } from "../v1/session"
import type { SessionSchema } from "./schema"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0]

export type Source = "user" | "assistant" | "reasoning" | "tools"

export type Field = { source: Source; label: string; text: string }

/** Long tool outputs are truncated in the index; searches beyond this miss. */
const FIELD_LIMIT = 512 * 1024

/** On boot, parts updated within this window are refreshed to re-index
 * streaming text; afterwards a time_updated cursor picks up exactly the parts
 * that changed since the last tick. */
const REFRESH_WINDOW = 30 * 60 * 1000

/** The cursor never advances into the last few seconds of wall clock, so a
 * write that commits just after a scan is still picked up by a later tick. */
const REFRESH_GRACE = 5 * 1000

/**
 * The sync loop yields to session work: batches grow only while ticks keep
 * succeeding, and any failure doubles the pause between ticks instead of
 * re-entering contention a second later.
 */
const TICK_MS = 1000
const TICK_MAX_MS = 60_000
const BATCH_MIN = 50
const BATCH_MAX = 500

export interface Interface {
  /** Brings the index up to date: new parts, changed parts, orphan cleanup. */
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
  time_updated: PartTable.time_updated,
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
    // Parts, messages, and sessions live in the main database and are only
    // ever read here; every index read and write goes to the separate search
    // database, so indexer transactions cannot block session persistence.
    const { db } = yield* Database.Service
    const { db: search } = yield* SearchDatabase.Service

    const lock = Semaphore.makeUnsafe(1)
    const frontierRow = yield* search
      .get<{ frontier: number | null }>(sql`SELECT max(part_rowid) AS frontier FROM part_search_text`)
      .pipe(Effect.orDie)
    let frontier = frontierRow?.frontier ?? 0
    let caughtUp = frontier > 0
    let tickMs = TICK_MS
    let batch = BATCH_MIN
    let refreshedThrough = Date.now() - REFRESH_WINDOW
    let sweepSessionCursor = ""
    let sweepRowCursor = 0

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
        yield* search
          .transaction((tx) =>
            Effect.gen(function* () {
              // Another sync loop (a second layer build in this process, or
              // another process sharing the search database) may have indexed
              // parts of this range already. Replace its rows so the unique
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
              for (const chunk of chunks(values, 400)) yield* tx.insert(PartSearchTextTable).values(chunk).run()
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

    /** Re-indexes parts whose data changed since the last tick so text that
     * kept streaming after indexing stays fresh. The time_updated cursor
     * walks oldest-first, so a backlog drains over ticks and every write is
     * seen exactly once; the compare below keeps re-reads cheap. */
    const refresh = (budget: number) =>
      Effect.gen(function* () {
        // A zero budget is a pacing no-op from the loop; it must not scan and
        // must not advance the cursor, or skipped-tick changes would be lost.
        if (budget <= 0) return
        const since = refreshedThrough - REFRESH_GRACE
        const rows = yield* db
          .select(partSelection)
          .from(PartTable)
          .where(and(gt(PartTable.time_updated, since), sql`rowid <= ${frontier}`))
          .orderBy(asc(PartTable.time_updated))
          .limit(budget)
          .all()
          .pipe(Effect.orDie)
        const scannedThrough = Math.min(
          rows.length > 0 ? rows[rows.length - 1]!.time_updated : Number.MAX_SAFE_INTEGER,
          Date.now() - REFRESH_GRACE,
        )
        refreshedThrough = Math.max(refreshedThrough, scannedThrough)
        if (rows.length === 0) return
        const [roles, projects] = yield* Effect.all([
          rolesFor(rows.map((row) => row.message_id)),
          projectsFor(rows.map((row) => row.session_id)),
        ])
        const indexed = yield* search
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
        yield* search
          .transaction((tx) =>
            Effect.gen(function* () {
              for (const row of changed) {
                const old = kept.get(row.id) ?? []
                yield* ftsDelete(tx, old)
                yield* tx.delete(PartSearchTextTable).where(eq(PartSearchTextTable.part_id, row.id)).run()
              }
              for (const chunk of chunks(rowsToValues(changed, roles, projects), 400))
                yield* tx.insert(PartSearchTextTable).values(chunk).run()
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

    /**
     * Drops index rows whose session or part is gone, e.g. after deletion.
     * The index cannot join across the two database files, so cursors walk
     * the index in batches and existence is checked in the main database.
     * Sessions go first: deleting a Session cascades its parts away, so the
     * indexed session_id column purges a whole deleted Session in one pass.
     * The part-level pass below still catches messages removed on their own.
     */
    const sweep = Effect.gen(function* () {
      const sessions = yield* search
        .selectDistinct({ session_id: PartSearchTextTable.session_id })
        .from(PartSearchTextTable)
        .where(sql`${PartSearchTextTable.session_id} > ${sweepSessionCursor}`)
        .orderBy(PartSearchTextTable.session_id)
        .limit(500)
        .all()
        .pipe(Effect.orDie)
      if (sessions.length === 0) {
        sweepSessionCursor = ""
      } else {
        sweepSessionCursor = sessions[sessions.length - 1]!.session_id
        const ids = sessions.map((row) => row.session_id)
        const alive = yield* db
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(inArray(SessionTable.id, ids))
          .all()
          .pipe(Effect.orDie)
        const known = new Set(alive.map((row) => row.id))
        for (const id of ids.filter((item) => !known.has(item))) {
          const doomed = yield* search
            .select({ rowid: sql<number>`rowid`, text: PartSearchTextTable.text })
            .from(PartSearchTextTable)
            .where(eq(PartSearchTextTable.session_id, id))
            .all()
            .pipe(Effect.orDie)
          yield* search
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* ftsDelete(tx, doomed)
                yield* tx.delete(PartSearchTextTable).where(eq(PartSearchTextTable.session_id, id)).run()
              }),
            )
            .pipe(Effect.orDie)
        }
      }

      const rows = yield* search
        .select({
          rowid: sql<number>`rowid`,
          part_id: PartSearchTextTable.part_id,
        })
        .from(PartSearchTextTable)
        .where(gt(PartSearchTextTable.part_rowid, sweepRowCursor))
        .orderBy(asc(PartSearchTextTable.part_rowid))
        .limit(500)
        .all()
        .pipe(Effect.orDie)
      if (rows.length === 0) {
        sweepRowCursor = 0
        return
      }
      sweepRowCursor = rows[rows.length - 1]!.rowid
      const ids = [...new Set(rows.map((row) => row.part_id))]
      const alive = yield* db
        .select({ id: PartTable.id })
        .from(PartTable)
        .where(inArray(PartTable.id, ids))
        .all()
        .pipe(Effect.orDie)
      const known = new Set(alive.map((row) => row.id))
      const missing = ids.filter((id) => !known.has(id))
      if (missing.length === 0) return
      // External-content FTS deletes need the stored text, but only for the
      // doomed rows; scanning text for every row would dominate the pass once
      // large tool outputs accumulate.
      const doomed = yield* search
        .select({ rowid: sql<number>`rowid`, text: PartSearchTextTable.text })
        .from(PartSearchTextTable)
        .where(inArray(PartSearchTextTable.part_id, missing))
        .all()
        .pipe(Effect.orDie)
      yield* search
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* ftsDelete(tx, doomed)
            yield* tx.run(
              sql`DELETE FROM part_search_text WHERE part_id IN (${sql.join(
                missing.map((id) => sql`${id}`),
                sql`, `,
              )})`,
            )
          }),
        )
        .pipe(Effect.orDie)
    })

    const run = (options?: { budget?: number; refresh?: number; sweep?: boolean }) =>
      lock.withPermit(
        Effect.gen(function* () {
          yield* catchUp(options?.budget ?? batch)
          // Streaming refresh is pointless until the backlog is indexed; the
          // loop passes refresh: 0 to pace steady-state churn to every 5th
          // tick, while explicit calls always refresh recent parts.
          const refreshBudget = options?.refresh ?? (options?.budget ? 500 : 2000)
          if ((caughtUp || options?.budget) && refreshBudget > 0) yield* refresh(refreshBudget)
          if (options?.sweep) yield* sweep
        }),
      )

    const sync = (options?: { budget?: number; refresh?: number; sweep?: boolean }) =>
      // Transient SQLite contention or any other failure degrades to a
      // skipped tick, never a killed sync loop or a failed tool call.
      run(options).pipe(
        Effect.catchCause((cause) => Effect.logError("session search index sync failed", { cause: Cause.pretty(cause) })),
      )

    let loopTicks = 0
    yield* Effect.forever(
      Effect.suspend(() => {
        // The loop paces refresh and sweep itself; explicit sync callers get
        // exactly what they asked for.
        const sweepThisTick = loopTicks % 20 === 1
        const refreshThisTick = loopTicks % 5 === 0
        loopTicks += 1
        return Effect.gen(function* () {
          const outcome = yield* run({ sweep: sweepThisTick, refresh: refreshThisTick ? undefined : 0 }).pipe(Effect.exit)
          if (Exit.isSuccess(outcome)) {
            tickMs = TICK_MS
            batch = Math.min(batch * 2, BATCH_MAX)
          } else {
            yield* Effect.logError("session search index sync failed", { cause: Cause.pretty(outcome.cause) })
            tickMs = Math.min(tickMs * 2, TICK_MAX_MS)
            batch = BATCH_MIN
          }
          yield* Effect.sleep(Duration.millis(tickMs))
        })
      }),
    ).pipe(Effect.forkScoped)

    return Service.of({ sync })
  }),
)

export const node = makeGlobalNode({
  name: "session-search-index",
  layer,
  deps: [Database.node, SearchDatabase.node],
})
