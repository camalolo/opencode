// Sustained load generator for opencode server.
// Usage: node loadgen.mjs [sessionID] [durationMs=15000] [concurrency=4]
//   BASE  env  server base URL (default http://localhost:4096)
//   DIR   env  project directory for directory-scoped endpoints (default: cwd)
const BASE = process.env.BASE || "http://localhost:4096"
const DIR = encodeURIComponent(process.env.DIR || process.cwd())
const SID = process.argv[2] || ""
const DURATION = Number(process.argv[3] || 15000)
const CONCURRENCY = Number(process.argv[4] || 4)

const mix = [
  `/app`,
  `/session`,
  `/session/status`,
  `/config`,
  `/agent`,
  `/doc`,
  `/provider`,
  `/lsp`,
  `/command`,
  `/skill`,
  `/project`,
  `/file/status?directory=${DIR}`,
  `/find/file?query=opencode&directory=${DIR}&limit=50`,
]
if (SID) mix.push(`/session/${SID}/message?limit=50`)

const lat = new Map()
async function hit(path) {
  const t0 = performance.now()
  try {
    const r = await fetch(BASE + path, { signal: AbortSignal.timeout(30000) })
    await r.arrayBuffer()
  } catch {}
  const ms = performance.now() - t0
  if (!lat.has(path)) lat.set(path, [])
  lat.get(path).push(ms)
}

const deadline = Date.now() + DURATION
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < deadline) await hit(mix[(Math.random() * mix.length) | 0])
  }),
)

const rows = [...lat.entries()]
  .map(([p, a]) => {
    a.sort((x, y) => x - y)
    return { path: p.slice(0, 60), n: a.length, p50: a[a.length >> 1], p95: a[Math.floor(a.length * 0.95)], max: a[a.length - 1] }
  })
  .sort((a, b) => b.p50 - a.p50)
let total = 0
for (const r of rows) {
  total += r.n
  console.log(r.p50.toFixed(0).padStart(6) + "ms p50 " + r.p95.toFixed(0).padStart(6) + "ms p95 " + r.max.toFixed(0).padStart(7) + "ms max  n=" + String(r.n).padEnd(4) + " " + r.path)
}
console.log("total requests:", total)
