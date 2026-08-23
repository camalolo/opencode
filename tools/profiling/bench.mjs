// Latency benchmark for opencode server (read-only endpoints).
// Usage: node bench.mjs [sessionID] [iterations] [--json]
//   BASE  env  server base URL (default http://localhost:4096)
//   DIR   env  project directory for directory-scoped endpoints (default: cwd)
const BASE = process.env.BASE || "http://localhost:4096"
const DIR = encodeURIComponent(process.env.DIR || process.cwd())
const SID = process.argv[2] || ""

const endpoints = [
  ["app", `/app`],
  ["session.list", `/session`],
  ["session.status", `/session/status`],
  ["config", `/config`],
  ["agent", `/agent`],
  ["doc", `/doc`],
  ["provider", `/provider`],
  ["lsp", `/lsp`],
  ["command", `/command`],
  ["skill", `/skill`],
  ["project", `/project`],
  ["vcs.status", `/vcs/status?directory=${DIR}`],
  ["file.status", `/file/status?directory=${DIR}`],
  ["find.file", `/find/file?query=opencode&directory=${DIR}&limit=50`],
  ["find.symbol", `/find/symbol?query=serve&directory=${DIR}`],
  ...(SID ? [["session.messages", `/session/${SID}/message?limit=50`]] : []),
]

const pct = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]

async function hit(path) {
  const t0 = performance.now()
  const res = await fetch(BASE + path, { signal: AbortSignal.timeout(20000) })
  const body = await res.arrayBuffer()
  return { ms: performance.now() - t0, code: res.status, bytes: body.byteLength }
}

for (const [, p] of endpoints) {
  try {
    await hit(p)
  } catch {}
}

const N = Number(process.argv[3] || 5)
const rows = []
for (const [name, p] of endpoints) {
  const samples = []
  let bytes = 0
  let code = 0
  for (let i = 0; i < N; i++) {
    try {
      const r = await hit(p)
      samples.push(r.ms)
      bytes = r.bytes
      code = r.code
    } catch (e) {
      samples.push(20000)
      code = "ERR:" + e.message.slice(0, 30)
    }
  }
  samples.sort((a, b) => a - b)
  rows.push({ name, code, p50: pct(samples, 0.5), p95: pct(samples, 0.95), max: samples[samples.length - 1], kb: (bytes / 1024).toFixed(0) })
}
rows.sort((a, b) => b.p50 - a.p50)
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ts: Date.now(), base: BASE, rows }))
} else {
  console.log("endpoint          p50      p95      max      KB    code")
  for (const r of rows) {
    console.log(r.name.padEnd(17), r.p50.toFixed(0).padStart(5) + "ms", r.p95.toFixed(0).padStart(6) + "ms", r.max.toFixed(0).padStart(7) + "ms", String(r.kb).padStart(6), String(r.code).padStart(6))
  }
}
