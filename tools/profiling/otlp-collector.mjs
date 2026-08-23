// Minimal local OTLP/HTTP collector for opencode traces.
// Accepts /v1/traces (JSON) -> appends one JSONL line per span; /v1/logs -> accepted, discarded.
// Rotates the trace file at ~64MB. No external deps.
//   PORT       env  listen port (default 4318)
//   TRACES_OUT env  output file (default ~/.local/share/opencode/log/traces.jsonl)
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const PORT = Number(process.env.PORT || 4318)
const OUT = process.env.TRACES_OUT || path.join(os.homedir(), ".local/share/opencode/log/traces.jsonl")
const MAX_BYTES = 64 << 20

const ATTR_ALLOW = /^(http|rpc|db|url|opencode|session|provider)\b/i

function flattenAttrs(attrs) {
  const out = {}
  if (!Array.isArray(attrs)) return out
  for (const a of attrs) {
    if (!ATTR_ALLOW.test(a.key)) continue
    const v = a.value ?? {}
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? null
  }
  return out
}

function rotateIfNeeded() {
  try {
    if (fs.statSync(OUT).size < MAX_BYTES) return
    const old = OUT + ".1"
    try {
      fs.rmSync(old)
    } catch {}
    fs.renameSync(OUT, old)
  } catch {}
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })

let spans = 0
const server = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (c) => chunks.push(c))
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{}")
    if (req.url?.startsWith("/v1/logs")) return // logs accepted, not persisted
    if (!req.url?.startsWith("/v1/traces")) return
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      return
    }
    const lines = []
    for (const rs of body.resourceSpans ?? []) {
      for (const ss of rs.scopeSpans ?? []) {
        for (const s of ss.spans ?? []) {
          lines.push(
            JSON.stringify({
              ts: Number(BigInt(s.startTimeUnixNano || 0) / 1000000n),
              name: s.name,
              dur: Number(BigInt(s.endTimeUnixNano || 0) - BigInt(s.startTimeUnixNano || 0)) / 1e6,
              trace: s.traceId,
              span: s.spanId,
              parent: s.parentSpanId ?? null,
              attrs: flattenAttrs(s.attributes),
            }),
          )
        }
      }
    }
    if (!lines.length) return
    rotateIfNeeded()
    fs.appendFileSync(OUT, lines.join("\n") + "\n")
    spans += lines.length
  })
})
server.listen(PORT, "127.0.0.1", () => {
  console.log(`otlp collector on http://127.0.0.1:${PORT} -> ${OUT}`)
})
setInterval(() => console.log(new Date().toISOString(), "spans collected:", spans), 60000).unref()
