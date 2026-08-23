// Aggregate spans JSONL -> per-span-name inclusive/exclusive time report.
// Exclusive time = span duration minus direct children durations (where time actually goes).
// Usage: node trace-report.mjs [traces.jsonl] [topN=40]
import fs from "node:fs"
import readline from "node:readline"

const file = process.argv[2] || "traces.jsonl"
const TOP = Number(process.argv[3] || 40)

const byTrace = new Map() // traceId -> Map<spanId, {name, dur, parent, childrenDur}>
const agg = new Map() // name -> {n, total, excl, max, durs[]}
let totalSpans = 0

const rl = readline.createInterface({ input: fs.createReadStream(file, "utf8") })
for await (const line of rl) {
  if (!line.trim()) continue
  let s
  try {
    s = JSON.parse(line)
  } catch {
    continue
  }
  totalSpans++
  let m = byTrace.get(s.trace)
  if (!m) {
    m = new Map()
    byTrace.set(s.trace, m)
  }
  m.set(s.span, { name: s.name, dur: s.dur, parent: s.parent, childrenDur: 0 })
}

for (const m of byTrace.values()) {
  for (const [id, sp] of m) {
    if (sp.parent && m.has(sp.parent)) m.get(sp.parent).childrenDur += sp.dur
  }
  for (const sp of m.values()) {
    const excl = Math.max(0, sp.dur - sp.childrenDur)
    let a = agg.get(sp.name)
    if (!a) {
      a = { n: 0, total: 0, excl: 0, max: 0, durs: [] }
      agg.set(sp.name, a)
    }
    a.n++
    a.total += sp.dur
    a.excl += excl
    a.max = Math.max(a.max, sp.dur)
    if (a.durs.length < 20000) a.durs.push(sp.dur)
  }
}

const p = (a, q) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * q))] : 0)
console.log(`== ${file}`)
console.log(`   ${totalSpans} spans, ${byTrace.size} traces\n`)
console.log("  excl_ms    incl_ms     avg_ms    p95_ms     max_ms    count  span")
const rows = [...agg.entries()].sort((a, b) => b[1].excl - a[1].excl).slice(0, TOP)
for (const [name, a] of rows) {
  console.log(a.excl.toFixed(0).padStart(9), a.total.toFixed(0).padStart(10), (a.total / a.n).toFixed(1).padStart(10), p(a.durs, 0.95).toFixed(1).padStart(10), a.max.toFixed(0).padStart(10), String(a.n).padStart(8), "  " + name)
}
