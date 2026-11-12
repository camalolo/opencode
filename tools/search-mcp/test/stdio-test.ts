#!/usr/bin/env bun
// search-mcp validation: spawns the server over stdio and exercises the MCP
// protocol plus the unified websearch fallback chains end to end.
//
//  A (real env):          2 tools listed; live search + scrape via tavily; forced-provider modes
//  B (exa fake, exa→ddg): exa 401 → live DuckDuckGo fallback
//  C (tinyfish fake):     tinyfish 401 → live DuckDuckGo fallback
//  D (exa fake, scrape):  exa 401 → live direct-fetch fallback
//
// Exit code 0 = all pass.

const REPO = import.meta.dir + "/.."
let failures = 0

function ok(cond: boolean, label: string) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`)
  if (!cond) failures++
}

class Server {
  proc: any
  private pending = new Map<number, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout> }>()
  private nextId = 1
  private buf = ""

  constructor(env: Record<string, string>) {
    this.proc = Bun.spawn(["bun", "run", "src/index.ts"], {
      cwd: REPO,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...process.env, ...env },
    })
    void this.readLoop()
  }

  private async readLoop() {
    const dec = new TextDecoder()
    for await (const chunk of this.proc.stdout) {
      this.buf += dec.decode(chunk, { stream: true })
      let idx: number
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx).trim()
        this.buf = this.buf.slice(idx + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          const p = this.pending.get(msg.id)
          if (p) {
            clearTimeout(p.timer)
            this.pending.delete(msg.id)
            p.resolve(msg)
          }
        } catch {
          console.log(`WARN  unparseable line: ${line.slice(0, 200)}`)
        }
      }
    }
  }

  request(method: string, params?: any, timeoutMs = 90_000): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`timeout: ${method} (id ${id})`))
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n")
    })
  }

  notify(method: string) {
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n")
  }

  async stop() {
    try {
      this.proc.stdin.end()
    } catch {}
    await Promise.race([this.proc.exited, new Promise((r) => setTimeout(r, 2000))])
    if (this.proc.exitCode === null) this.proc.kill()
  }
}

async function init(s: Server) {
  const res = await s.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-test", version: "0.0.1" },
  })
  return res.result
}

function payload(resp: any): any {
  const text = resp?.result?.content?.map((c: any) => c?.text ?? "").join("") ?? ""
  try {
    return JSON.parse(text)
  } catch {
    return { __raw: text }
  }
}

async function main() {
  // ------------------------------------------------------------- A: real env
  console.log("\n== A: real environment (tavily first) ==")
  const a = new Server({})
  try {
    const initA = await init(a)
    ok(initA?.serverInfo?.name === "search-mcp" && initA?.serverInfo?.version === "0.2.0", `initialize: ${initA?.serverInfo?.name}@${initA?.serverInfo?.version}`)

    const listA = await a.request("tools/list")
    const namesA: string[] = listA.result.tools.map((t: any) => t.name)
    ok(JSON.stringify(namesA) === JSON.stringify(["search", "scrape"]), `tools/list: exactly 2 inner tools (${namesA.join(", ")})`)

    const sr = await a.request("tools/call", {
      name: "search",
      arguments: { query: "Bun JavaScript runtime", max_results: 3 },
    })
    ok(!sr.result?.isError, "search: no isError")
    const sj = payload(sr)
    ok(sj?.provider === "tavily", `search: served by ${sj?.provider}`)
    ok(Array.isArray(sj?.results) && sj.results.length >= 1 && !!sj.results[0]?.url, `search: ${sj?.results?.length} results, first=${sj?.results?.[0]?.url ?? "?"}`)

    const er = await a.request("tools/call", {
      name: "scrape",
      arguments: { urls: ["https://bun.com"] },
    })
    ok(!er.result?.isError, "scrape: no isError")
    const ej = payload(er)
    ok(ej?.provider === "tavily", `scrape: served by ${ej?.provider}`)
    ok((ej?.results?.[0]?.content ?? "").length > 200, `scrape: ${ej?.results?.[0]?.content?.length ?? 0} bytes from ${ej?.results?.[0]?.url}`)

    // forced provider without a key must fail cleanly (no silent fallback)
    const fk = await a.request("tools/call", {
      name: "search",
      arguments: { query: "test", provider: "exa" },
    })
    ok(fk.result?.isError === true && /no API key/.test(fk.result?.content?.[0]?.text ?? ""), "forced exa without key: clean isError")

    // forced tavily still works
    const ft = await a.request("tools/call", {
      name: "search",
      arguments: { query: "opencode documentation", provider: "tavily" },
    })
    ok(!ft.result?.isError && payload(ft)?.provider === "tavily", "forced tavily: works")

    const uk = await a.request("tools/call", { name: "no_such_tool", arguments: {} })
    ok(uk.result?.isError === true, "unknown tool: isError=true")
    const unknownMethod = await a.request("resources/read", { uri: "file:///x" })
    ok(unknownMethod?.error?.code === -32601, "unknown method: -32601")
  } finally {
    await a.stop()
  }

  // ------------------------------------------- B: exa fake → live DDG search
  console.log("\n== B: SEARCH_MCP_CHAIN=exa,duckduckgo + fake EXA (auth-fail fallback) ==")
  const b = new Server({ SEARCH_MCP_CHAIN: "exa,duckduckgo", EXA_API_KEY: "fake-key-plumbing-test" })
  try {
    await init(b)
    const sr = await b.request("tools/call", { name: "search", arguments: { query: "example domain info" } })
    const sj = payload(sr)
    if (!sr.result?.isError) {
      ok(sj?.provider === "duckduckgo", `search: fell back to ${sj?.provider}`)
      ok(Array.isArray(sj?.results) && sj.results.length >= 1 && !!sj.results[0]?.url, `search: ${sj?.results?.length} ddg results`)
    } else {
      // ddg may be IP-tempered; the chain must still show correct order + propagated errors
      const raw = sr.result?.content?.[0]?.text ?? ""
      ok(/exa:.*401[\s\S]*duckduckgo:/.test(raw), `search: chain order + errors propagated (ddg tempered) — ${raw.slice(0, 90)}…`)
    }
  } finally {
    await b.stop()
  }

  // --------------------------------------- C: tinyfish fake → live DDG search
  console.log("\n== C: SEARCH_MCP_CHAIN=tinyfish,duckduckgo + fake TINYFISH ==")
  const c = new Server({ SEARCH_MCP_CHAIN: "tinyfish,duckduckgo", TINYFISH_API_KEY: "fake-key-plumbing-test" })
  try {
    await init(c)
    const sr = await c.request("tools/call", { name: "search", arguments: { query: "bun runtime" } })
    const sj = payload(sr)
    if (!sr.result?.isError) {
      ok(sj?.provider === "duckduckgo", `search: tinyfish 401 → ${sj?.provider}`)
    } else {
      const raw = sr.result?.content?.[0]?.text ?? ""
      ok(/tinyfish:.*401[\s\S]*duckduckgo:/.test(raw), `search: tinyfish attempted → ddg tempered (order correct) — ${raw.slice(0, 90)}…`)
    }
  } finally {
    await c.stop()
  }

  // --------------------------------------- D: exa fake → live direct scrape
  console.log("\n== D: scrape fallback to direct fetch ==")
  const d = new Server({ SEARCH_MCP_CHAIN: "exa,duckduckgo", EXA_API_KEY: "fake-key-plumbing-test" })
  try {
    await init(d)
    const sr = await d.request("tools/call", { name: "scrape", arguments: { urls: ["https://example.com"] } })
    ok(!sr.result?.isError, "scrape: no isError despite exa 401")
    const sj = payload(sr)
    ok(sj?.provider === "direct", `scrape: fell back to ${sj?.provider}`)
    ok(/Example Domain/.test(sj?.results?.[0]?.content ?? ""), "scrape: direct fetch got real page content")
  } finally {
    await d.stop()
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error("test harness error:", e)
  process.exit(1)
})
