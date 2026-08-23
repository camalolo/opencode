// Aggregate full stack paths for selected functions in a .cpuprofile.
// Usage: node stacks.mjs <file.cpuprofile> [functionName ...]
import fs from "node:fs"
const p = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
const targets = process.argv.slice(3) // function names to trace
const parent = new Map()
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n)

function frame(n) {
  const cf = n.callFrame
  const url = (cf.url || "native").split("/").slice(-1)[0]
  return `${cf.functionName || "(anon)"}@${url}:${cf.lineNumber + 1}`
}
function stackOf(n) {
  const out = []
  let cur = n
  let depth = 0
  while (cur && depth < 40) {
    out.push(frame(cur))
    cur = parent.get(cur.id)
    depth++
  }
  return out
}
const agg = new Map()
let total = 0
for (const n of p.nodes) {
  if (!n.hitCount) continue
  total += n.hitCount
  const name = n.callFrame.functionName || "(anon)"
  if (!targets.some((t) => name.includes(t))) continue
  const stack = stackOf(n).reverse().join("\n    ")
  agg.set(stack, (agg.get(stack) || 0) + n.hitCount)
}
for (const [stack, hits] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`\n${((100 * hits) / total).toFixed(1)}%  (${hits} hits)`)
  console.log("    " + stack)
}
if (agg.size === 0) console.log("no matching functions found")
