// Analyze a .cpuprofile: self-time by function and by module.
// Usage: node analyze.mjs <file.cpuprofile> [topN=40]
import fs from "node:fs"

const file = process.argv[2]
const topN = Number(process.argv[3] || 40)
const p = JSON.parse(fs.readFileSync(file, "utf8"))
const intervalUs = (p.endTime - p.startTime) / p.samples.length

let hitTotal = 0
const byFn = new Map()
const byUrl = new Map()

function shortUrl(url) {
  if (!url) return "(native/builtin)"
  const m = url.match(/[^/]+$/)
  return m ? m[0] : url.slice(0, 60)
}

for (const n of p.nodes) {
  if (!n.hitCount) continue
  hitTotal += n.hitCount
  const cf = n.callFrame
  const fnKey = `${cf.functionName || "(anonymous)"} @ ${shortUrl(cf.url)}:${cf.lineNumber + 1}`
  byFn.set(fnKey, (byFn.get(fnKey) || 0) + n.hitCount)
  byUrl.set(shortUrl(cf.url), (byUrl.get(shortUrl(cf.url)) || 0) + n.hitCount)
}

const ms = (hits) => ((hits / hitTotal) * (intervalUs * hitTotal) / 1000).toFixed(1)
const pctf = (hits) => ((100 * hits) / hitTotal).toFixed(1).padStart(5) + "%"

console.log(`== ${file}: ${hitTotal} samples, ~${((intervalUs * hitTotal) / 1000).toFixed(0)}ms CPU ==\n`)
console.log("--- self time by module ---")
for (const [url, hits] of [...byUrl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
  console.log(pctf(hits), ms(hits).padStart(8) + "ms", url)
}
console.log("\n--- self time by function ---")
for (const [fn, hits] of [...byFn.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  console.log(pctf(hits), ms(hits).padStart(8) + "ms", fn)
}
