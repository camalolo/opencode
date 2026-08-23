// Aggregate slow-requests.jsonl by normalized route.
// Usage: node slow-report.mjs [slow-requests.jsonl]
//   Default file: ~/.local/share/opencode/log/slow-requests.jsonl (both Windows and Linux)
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const file = process.argv[2] || path.join(os.homedir(), ".local/share/opencode/log/slow-requests.jsonl")

const rows = fs
  .readFileSync(file, "utf8")
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l))

const byPath = {}
for (const r of rows) {
  const k = (r.method + " " + r.path).replace(/ses_[A-Za-z0-9]+/, ":id").replace(/\?(directory|path|mode)=[^&]*/g, "")
  byPath[k] ??= { n: 0, ms: [], max: 0 }
  byPath[k].n++
  byPath[k].ms.push(r.ms)
  byPath[k].max = Math.max(byPath[k].max, r.ms)
}

console.log(`=== slow requests by route (>250ms): ${file} ===`)
for (const [k, a] of Object.entries(byPath).sort((x, y) => y[1].n - x[1].n)) {
  a.ms.sort((x, y) => x - y)
  console.log(k.padEnd(55), ("n=" + String(a.n)).padStart(4), " p50=" + String(a.ms[a.ms.length >> 1] + "ms").padStart(7), " max=" + String(a.max + "ms").padStart(8))
}
console.log("total:", rows.length, "| range:", new Date(rows[0].ts).toISOString(), "->", new Date(rows[rows.length - 1].ts).toISOString())
