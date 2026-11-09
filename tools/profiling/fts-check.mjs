// FTS5 integrity check for opencode databases. Run with BUN, not node and
// not the system sqlite3 CLI: opencode's writer (bun's bundled SQLite,
// currently 3.53) writes FTS5 segment data that older engines misparse, so
// a system CLI as old as Debian's 3.40 reports bogus "malformed" verdicts.
// This tool uses bun's SQLite - the same engine that wrote the index.
//
//   bun tools/profiling/fts-check.mjs ~/.local/share/opencode/opencode-search.db
//
// Exits 0 when the index is exact, 1 on mismatch, 2 on a busy database
// (retry when the indexer is not writing).
import { Database } from "bun:sqlite"

const path = process.argv[2]
if (!path) {
  console.error("usage: bun tools/profiling/fts-check.mjs <fts5-database.db>")
  process.exit(2)
}

const db = new Database(path)
db.run("PRAGMA busy_timeout = 10000")

const fts = db
  .query("SELECT name FROM sqlite_master WHERE type = 'table' AND instr(sql, 'fts5') > 0 ORDER BY name")
  .all()
  .map((row) => row.name)
if (fts.length === 0) {
  console.log("no fts5 tables found")
  process.exit(0)
}

let verdict = 0
for (const table of fts) {
  // External-content tables keep rows in their content table, so count(*)
  // on the fts table reports content rows, not index postings.
  const docs = db.query(`SELECT count(*) AS n FROM "${table}"`).get().n
  try {
    db.run(`INSERT INTO "${table}"("${table}", rank) VALUES('integrity-check', 1)`)
    console.log(`${table}: exact - ${docs} rows, rank-1 PASS`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("locked") || message.includes("busy")) {
      console.log(`${table}: database busy, retry later`)
      verdict = 2
      continue
    }
    console.log(`${table}: rank-1 FAIL (${message})`)
    verdict = 1
  }
}
db.close()
process.exit(verdict)
