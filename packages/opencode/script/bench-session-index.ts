/**
 * Benchmark and profiling harness for the session transcript search indexer
 * (packages/core/src/session/search-index.ts).
 *
 * Point OPENCODE_DB at a copy of real data (never the live database), then:
 *
 *   OPENCODE_DB=/tmp/prof/opencode.db bun script/bench-session-index.ts catchup [seconds] [budget]
 *   OPENCODE_DB=/tmp/prof/opencode.db bun script/bench-session-index.ts refresh [parts] [budget]
 *   OPENCODE_DB=/tmp/prof/opencode.db bun script/bench-session-index.ts sweep [rounds]
 *   OPENCODE_DB=/tmp/prof/opencode.db bun script/bench-session-index.ts stats
 *
 * `catchup` deletes the search database first and indexes the whole transcript
 * backlog, one explicit sync per tick. To skip dead ranges of the source table
 * (orphan parts whose session is gone) it seeds a marker row so the boot
 * frontier starts past them; the marker pins an explicit rowid and carries an
 * FTS entry so the post-run integrity check stays meaningful. `refresh` first
 * rewrites time_updated on the newest N parts (simulating text that streamed
 * after indexing), then drains them through the refresh path. `sweep` measures
 * orphan-cleanup ticks.
 *
 * CPU profile: run the same command under `bun --cpu-prof --cpu-prof-dir=...`
 * and analyze with tools/profiling/analyze.mjs / stacks.mjs.
 */
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database as BunSqlite } from "bun:sqlite"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { SearchDatabase } from "@opencode-ai/core/database/search-database"
import { SearchIndex } from "@opencode-ai/core/session/search-index"

const HEARTBEAT_MS = 20

const [phase = "stats", argA, argB] = process.argv.slice(2)
const databasePath = process.env.OPENCODE_DB
if (!databasePath || !databasePath.endsWith(".db")) {
  console.error("OPENCODE_DB must point at a dataset copy, e.g. /tmp/prof/opencode.db")
  process.exit(1)
}
const searchPath = databasePath.slice(0, -".db".length) + "-search.db"

// Event-loop stall sampler: max lateness of a 20ms timer, i.e. how long the
// process was blocked by synchronous work.
const beat = { last: performance.now(), max: 0 }
const timer = setInterval(() => {
  const now = performance.now()
  beat.max = Math.max(beat.max, now - beat.last - HEARTBEAT_MS)
  beat.last = now
}, HEARTBEAT_MS)
const resetBeat = () => {
  beat.last = performance.now()
  beat.max = 0
}

const mb = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
const report = (ticks: number[]) => {
  const sorted = ticks.toSorted((a, b) => a - b)
  return {
    ticks: sorted.length,
    p50: Number(pct(sorted, 0.5).toFixed(1)),
    p95: Number(pct(sorted, 0.95).toFixed(1)),
    max: Number(sorted[sorted.length - 1].toFixed(1)),
    total: Number(sorted.reduce((sum, ms) => sum + ms, 0).toFixed(0)),
    maxStall: Number(beat.max.toFixed(1)),
  }
}

/** Default start rowid: rowids 1..215464 in the reference copy are orphan
 * parts (session row gone) that the indexer skips while still advancing the
 * frontier, so a catchup bench normally starts past them. */
const DEFAULT_START_ROWID = 215465

async function rmSearchDatabase() {
  const { rm } = await import("node:fs/promises")
  await Promise.all([rm(searchPath, { force: true }), rm(searchPath + "-wal", { force: true }), rm(searchPath + "-shm", { force: true })])
}

/** Seeds the boot frontier past dead ranges: the indexer reads max(part_rowid)
 * once at layer build, before any bench code can insert through the service.
 * The marker row also gets its FTS entry so a post-run integrity-check(1)
 * against the content table can pass. */
function seedSearchDatabase(startRowid: number) {
  const db = new BunSqlite(searchPath)
  db.run(
    `CREATE TABLE IF NOT EXISTS part_search_text (
      part_rowid integer NOT NULL, part_id text NOT NULL, ordinal integer NOT NULL,
      session_id text NOT NULL, project_id text NOT NULL, source text NOT NULL,
      label text NOT NULL, time_created integer NOT NULL, text text NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS part_search_text_field_idx ON part_search_text (part_id, ordinal);
    CREATE INDEX IF NOT EXISTS part_search_text_part_rowid_idx ON part_search_text (part_rowid);
    CREATE INDEX IF NOT EXISTS part_search_text_session_idx ON part_search_text (session_id);
    CREATE INDEX IF NOT EXISTS part_search_text_time_idx ON part_search_text (time_created);
    CREATE VIRTUAL TABLE IF NOT EXISTS part_search USING fts5(text, content='part_search_text', content_rowid='rowid', tokenize='trigram');`,
  )
  db.run(
    `INSERT INTO part_search_text (rowid, part_rowid, part_id, ordinal, session_id, project_id, source, label, time_created, text)
     VALUES (${startRowid - 1}, ${startRowid - 1}, '__bench_marker__', 0, 'm', 'm', 'user', 'bench marker', 0, 'bench marker text');
    INSERT INTO part_search(rowid, text) VALUES (${startRowid - 1}, 'bench marker text');`,
  )
  db.close()
}

if (phase === "catchup") {
  await rmSearchDatabase()
  seedSearchDatabase(Number(process.env.BENCH_START_ROWID ?? DEFAULT_START_ROWID))
}

const layer = LayerNode.compile(LayerNode.group([SearchIndex.node, SearchDatabase.node, Database.node]))

const program = Effect.gen(function* () {
  const index = yield* SearchIndex.Service
  const { db: search } = yield* SearchDatabase.Service
  const { db } = yield* Database.Service

  const indexStats = () =>
    Effect.gen(function* () {
      const row = yield* search
        .get<{ fields: number; bytes: number; frontier: number }>(
          // The bench marker row (which seeds the frontier past dead ranges)
          // is excluded from field counts but its part_rowid still defines the
          // frontier.
          sql`SELECT (SELECT count(*) FROM part_search_text WHERE part_id <> '__bench_marker__') AS fields,
                     (SELECT coalesce(sum(length(text)), 0) FROM part_search_text WHERE part_id <> '__bench_marker__') AS bytes,
                     (SELECT coalesce(max(part_rowid), 0) FROM part_search_text) AS frontier`,
        )
        .pipe(Effect.orDie)
      return row!
    })

  const sourceStats = () =>
    Effect.gen(function* () {
      const row = yield* db
        .get<{ parts: number; max_rowid: number; messages: number; sessions: number }>(
          sql`SELECT (SELECT count(*) FROM part) AS parts, (SELECT coalesce(max(rowid), 0) FROM part) AS max_rowid,
                     (SELECT count(*) FROM message) AS messages, (SELECT count(*) FROM session) AS sessions`,
        )
        .pipe(Effect.orDie)
      return row!
    })

  const initial = yield* indexStats()
  console.log(
    JSON.stringify({ phase, databasePath, searchPath, start: { ...initial, indexedMB: Number(mb(initial.bytes)) } }),
  )

  if (phase === "stats") {
    const source = yield* sourceStats()
    const done = yield* indexStats()
    console.log(
      JSON.stringify({
        source,
        index: { ...done, indexedMB: Number(mb(done.bytes)), avgFieldBytes: Math.round(done.bytes / Math.max(1, done.fields)) },
        lagParts: source.max_rowid - done.frontier,
      }),
    )
    return
  }

  if (phase === "catchup") {
    const seconds = Number(argA ?? 20)
    const budget = Number(argB ?? 200)
    // BENCH_CHECK_EVERY=<ticks> runs a strict FTS5 integrity check (index vs
    // content table) after every Nth tick. It uses a raw connection in this
    // process, which contends with the sync loop's writer; prefer checking a
    // finished index from a separate `bun -e` process. Do NOT use the system
    // sqlite3 CLI: an older CLI (e.g. 3.40) misreads segment data written by
    // bun's newer SQLite and reports bogus "malformed" verdicts.
    const checkEvery = Number(process.env.BENCH_CHECK_EVERY ?? 0)
    const integrityCheck = () =>
      Effect.sync(() => {
        // Not readonly: the integrity-check runs through an INSERT control
        // statement, which SQLite refuses on a readonly connection even
        // though it writes nothing. Locking is contention with the sync
        // loop's writer, not corruption - wait and retry.
        for (let attempt = 0; attempt < 5; attempt++) {
          const raw = new BunSqlite(searchPath)
          try {
            raw.run("PRAGMA busy_timeout = 10000")
            raw.run("INSERT INTO part_search(part_search, rank) VALUES('integrity-check', 1)")
            return "ok"
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (!message.includes("locked") || attempt === 4) return message
          } finally {
            raw.close()
          }
        }
        return "unreachable"
      })
    const source = yield* sourceStats()
    const deadline = performance.now() + seconds * 1000
    const ticks: number[] = []
    let fieldsStart = initial.fields
    let partsStart = initial.frontier
    resetBeat()
    while (performance.now() < deadline && initial.frontier + 0 < source.max_rowid) {
      const before = yield* indexStats()
      const started = performance.now()
      yield* index.sync({ budget, refresh: 0 })
      const elapsed = performance.now() - started
      ticks.push(elapsed)
      const after = yield* indexStats()
      if (before.frontier === after.frontier && before.fields === after.fields) break
      const tick = {
        tick: ticks.length,
        ms: Number(elapsed.toFixed(1)),
        parts: after.frontier - before.frontier,
        fields: after.fields - before.fields,
        bytes: after.bytes - before.bytes,
        frontier: after.frontier,
        stall: Number(beat.max.toFixed(1)),
      }
      console.log(JSON.stringify(tick))
      if (checkEvery > 0 && ticks.length % checkEvery === 0) {
        const verdict = yield* integrityCheck()
        console.log(JSON.stringify({ integrity: { tick: ticks.length, frontier: after.frontier, verdict } }))
        if (verdict !== "ok") break
      }
      if (after.frontier >= source.max_rowid) break
    }
    const done = yield* indexStats()
    const wall = ticks.reduce((sum, ms) => sum + ms, 0)
    console.log(
      JSON.stringify({
        summary: {
          ...report(ticks),
          budget,
          fields: done.fields - fieldsStart,
          parts: done.frontier - partsStart,
          indexedMB: Number(mb(done.bytes - initial.bytes)),
          fieldsPerSecond: Math.round(((done.fields - fieldsStart) / Math.max(1, wall)) * 1000),
          partsPerSecond: Math.round(((done.frontier - partsStart) / Math.max(1, wall)) * 1000),
          remainingParts: source.max_rowid - done.frontier,
        },
      }),
    )
    return
  }

  if (phase === "refresh") {
    const parts = Number(argA ?? 20000)
    const budget = Number(argB ?? 2000)
    const ts = Date.now()
    yield* db
      .run(
        sql`UPDATE part SET time_updated = ${ts} - (rowid % 60000) WHERE rowid IN (SELECT rowid FROM part ORDER BY rowid DESC LIMIT ${parts})`,
      )
      .pipe(Effect.orDie)
    const ticks: number[] = []
    let fieldsStart = initial.fields
    let bytesStart = initial.bytes
    resetBeat()
    for (let round = 0; round < Math.ceil(parts / budget) + 6; round++) {
      const before = yield* indexStats()
      const started = performance.now()
      yield* index.sync({ budget: 0, refresh: budget })
      const elapsed = performance.now() - started
      ticks.push(elapsed)
      const after = yield* indexStats()
      console.log(
        JSON.stringify({
          tick: round + 1,
          ms: Number(elapsed.toFixed(1)),
          fields: after.fields - before.fields,
          bytes: after.bytes - before.bytes,
          frontier: after.frontier,
          stall: Number(beat.max.toFixed(1)),
        }),
      )
      // Two consecutive ticks where the cursor advanced nothing means drained.
      if (after.frontier === before.frontier && after.fields === before.fields && round > Math.ceil(parts / budget))
        break
    }
    const done = yield* indexStats()
    console.log(
      JSON.stringify({
        summary: {
          ...report(ticks),
          touchedParts: parts,
          refreshBudget: budget,
          fields: done.fields - fieldsStart,
          bytes: done.bytes - bytesStart,
          indexedMB: Number(mb(done.bytes - bytesStart)),
        },
      }),
    )
    return
  }

  if (phase === "sweep") {
    const rounds = Number(argA ?? 30)
    const ticks: number[] = []
    resetBeat()
    for (let round = 0; round < rounds; round++) {
      const started = performance.now()
      yield* index.sync({ budget: 0, refresh: 0, sweep: true })
      ticks.push(performance.now() - started)
    }
    const done = yield* indexStats()
    console.log(
      JSON.stringify({
        summary: {
          ...report(ticks),
          rounds,
          sweepTicksPerFullPass: Math.ceil(done.fields / 500),
        },
      }),
    )
    return
  }

  console.error(`unknown phase ${phase}`)
  process.exitCode = 1
})

await program.pipe(Effect.provide(layer), Effect.runPromise)
clearInterval(timer)
