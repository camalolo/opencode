// search-mcp providers: direct REST/MCP clients for Tavily, Exa, TinyFish,
// plus two keyless fallbacks: DuckDuckGo HTML search and direct URL fetch.
// Every provider exposes `searchN(args, key)` and/or `scrapeN(args, key)`
// returning a normalized `{ provider, results }` shape or throwing on failure.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const TIMEOUT_MS = 30_000
const MAX_CONTENT = 60_000
const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

export type SearchResult = { title: string; url: string; snippet: string }
export type ScrapeResult = { url: string; title?: string; content: string }

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

function fileKey(path: string): string | null {
  try {
    const v = readFileSync(path, "utf8").trim()
    return v || null
  } catch {
    return null
  }
}

// Keys set from the opencode settings UI land in the shared auth store
// (<xdg data dir>/opencode/auth.json) as `websearch-<provider>` API entries.
function authStoreKey(id: string): string | null {
  try {
    const dataDir = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share")
    const auth = JSON.parse(readFileSync(join(dataDir, "opencode", "auth.json"), "utf8"))
    const entry = auth?.[`websearch-${id}`]
    const key = entry?.type === "api" ? entry.key : undefined
    return typeof key === "string" && key.trim() ? key.trim() : null
  } catch {
    return null
  }
}

export function loadKeys() {
  return {
    tavily: process.env.TAVILY_API_KEY?.trim() || authStoreKey("tavily") || fileKey(join(homedir(), ".tavily")),
    exa: process.env.EXA_API_KEY?.trim() || authStoreKey("exa") || fileKey(join(homedir(), ".exa")),
    tinyfish:
      process.env.TINYFISH_API_KEY?.trim() || authStoreKey("tinyfish") || fileKey(join(homedir(), ".tinyfish")),
  }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function httpJson(url: string, init: RequestInit, label: string): Promise<any> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { ...init, signal: ac.signal })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`${label}: HTTP ${res.status} — ${text.slice(0, 300)}`)
    }
    if (!text) return {}
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text.slice(0, MAX_CONTENT) }
    }
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`${label}: timed out after ${TIMEOUT_MS / 1000}s`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Arg helpers
// ---------------------------------------------------------------------------

const asStr = (v: any) => String(v)
const asNum = (v: any) => Number(v)
const asIs = (v: any) => v

function pick(o: any, spec: Record<string, (v: any) => any>): Record<string, any> {
  const out: Record<string, any> = {}
  for (const [k, fn] of Object.entries(spec)) {
    const v = o?.[k]
    if (v !== undefined && v !== null && v !== "") out[k] = fn(v)
  }
  return out
}

export function recencyToDays(recency?: string): number | null {
  switch (recency) {
    case "day":
      return 1
    case "week":
      return 7
    case "month":
      return 30
    case "year":
      return 365
    default:
      return null
  }
}

function daysAgoISO(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

// ---------------------------------------------------------------------------
// HTML text helpers (DDG search, direct fetch)
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16))
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? m
  })
}

export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
}

export function htmlToText(html: string, maxChars = MAX_CONTENT): string {
  const noScript = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ")
  const text = decodeEntities(stripTags(noScript))
  return text.length > maxChars ? text.slice(0, maxChars) + "\n…[truncated]" : text
}

function truncate(s: string | undefined, max = MAX_CONTENT): string {
  if (!s) return ""
  return s.length > max ? s.slice(0, max) + "\n…[truncated]" : s
}

// ---------------------------------------------------------------------------
// Tavily — REST (api.tavily.com)
// ---------------------------------------------------------------------------

const TAVILY_API = "https://api.tavily.com"

async function tavily(path: string, body: Record<string, any>, key: string): Promise<any> {
  return httpJson(
    `${TAVILY_API}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    },
    `tavily/${path.slice(1)}`,
  )
}

export async function tavilySearchN(args: any, key: string): Promise<{ provider: string; results: SearchResult[] }> {
  const body = pick(args, {
    query: asStr,
    max_results: asNum,
    search_depth: asStr,
    topic: asStr,
    time_range: asStr,
    include_domains: asIs,
    exclude_domains: asIs,
  })
  body.max_results ??= 5
  const data = await tavily("/search", body, key)
  const results: SearchResult[] = (data?.results ?? []).map((r: any) => ({
    title: r?.title ?? "",
    url: r?.url ?? "",
    snippet: truncate(r?.content, 4000),
  }))
  return { provider: "tavily", results }
}

export async function tavilyScrapeN(args: any, key: string): Promise<{ provider: string; results: ScrapeResult[] }> {
  const urls: string[] = args?.urls
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("tavily scrape: urls[] required")
  const body = pick(args, { urls: asIs, extract_depth: asStr })
  const data = await tavily("/extract", body, key)
  const results: ScrapeResult[] = (data?.results ?? []).map((r: any) => ({
    url: r?.url ?? "",
    title: r?.title,
    content: truncate(r?.raw_content),
  }))
  if (results.length === 0) throw new Error(`tavily scrape: no content returned (failed: ${JSON.stringify(data?.failed_results ?? [])})`)
  return { provider: "tavily", results }
}

// ---------------------------------------------------------------------------
// Exa — REST (api.exa.ai)
// ---------------------------------------------------------------------------

const EXA_API = "https://api.exa.ai"

async function exa(path: string, body: Record<string, any>, key: string): Promise<any> {
  return httpJson(
    `${EXA_API}${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify(body),
    },
    `exa/${path.slice(1)}`,
  )
}

export async function exaSearchN(args: any, key: string): Promise<{ provider: string; results: SearchResult[] }> {
  const body: Record<string, any> = { query: String(args?.query ?? ""), numResults: Number(args?.max_results ?? 5) }
  const category = args?.category ? String(args.category) : undefined
  if (category) body.category = category
  const inc = args?.include_domains
  const exc = args?.exclude_domains
  if (Array.isArray(inc) && inc.length) body.includeDomains = inc
  if (Array.isArray(exc) && exc.length) body.excludeDomains = exc
  const days = recencyToDays(args?.recency)
  if (days) body.startPublishedDate = daysAgoISO(days)
  const data = await exa("/search", body, key)
  const results: SearchResult[] = (data?.results ?? []).map((r: any) => ({
    title: r?.title ?? "",
    url: r?.url ?? "",
    snippet: truncate(r?.text, 4000),
  }))
  return { provider: "exa", results }
}

export async function exaScrapeN(args: any, key: string): Promise<{ provider: string; results: ScrapeResult[] }> {
  const urls: string[] = args?.urls
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("exa scrape: urls[] required")
  try {
    const data = await exa("/contents", { ids: urls, text: true }, key)
    const results: ScrapeResult[] = (data?.results ?? []).map((r: any) => ({
      url: r?.url ?? "",
      title: r?.title,
      content: truncate(r?.text),
    }))
    if (results.length === 0) throw new Error("exa scrape: empty response")
    return { provider: "exa", results }
  } catch (e: any) {
    // Older API revisions expect `urls` instead of `ids` — retry once on 400.
    if (/HTTP 400/.test(String(e?.message))) {
      const data = await exa("/contents", { urls, text: true }, key)
      const results: ScrapeResult[] = (data?.results ?? []).map((r: any) => ({
        url: r?.url ?? "",
        title: r?.title,
        content: truncate(r?.text),
      }))
      if (results.length === 0) throw new Error("exa scrape: empty response")
      return { provider: "exa", results }
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// TinyFish — hosted MCP (agent.tinyfish.ai/mcp) over streamable HTTP.
// One fresh session per call; API key sent as X-API-Key.
// ---------------------------------------------------------------------------

const TINYFISH_MCP = "https://agent.tinyfish.ai/mcp"
const CLIENT_INFO = { name: "search-mcp", version: "0.2.0" }

function parseSseResponse(text: string, id: unknown): any {
  for (const line of text.split("\n")) {
    const l = line.trim()
    if (!l.startsWith("data:")) continue
    const payload = l.slice(5).trim()
    if (!payload || payload === "[DONE]") continue
    try {
      const obj = JSON.parse(payload)
      if (obj && typeof obj === "object" && ("result" in obj || "error" in obj)) {
        if (id === undefined || obj.id === id) return obj
      }
    } catch {
      // ignore non-JSON SSE lines
    }
  }
  return null
}

async function tfPost(
  key: string,
  session: string | null,
  body: Record<string, any>,
  expectResponse: boolean,
): Promise<{ json: any; session: string | null }> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-API-Key": key,
    }
    if (session) headers["Mcp-Session-Id"] = session
    const res = await fetch(TINYFISH_MCP, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    const sid = res.headers.get("mcp-session-id")
    const ctype = res.headers.get("content-type") ?? ""
    const text = await res.text()
    if (!res.ok) throw new Error(`tinyfish: HTTP ${res.status} — ${text.slice(0, 300)}`)
    let json: any = null
    if (ctype.includes("text/event-stream")) {
      json = parseSseResponse(text, body.id)
    } else if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    if (expectResponse && !json) throw new Error("tinyfish: no JSON-RPC response in reply")
    return { json, session: sid }
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error(`tinyfish: timed out after ${TIMEOUT_MS / 1000}s`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

async function tfCallTool(key: string, tool: string, targs: Record<string, any>): Promise<any> {
  const r1 = await tfPost(
    key,
    null,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: CLIENT_INFO },
    },
    true,
  )
  if (r1.json.error) throw new Error(`tinyfish initialize: ${JSON.stringify(r1.json.error)}`)
  await tfPost(key, r1.session, { jsonrpc: "2.0", method: "notifications/initialized" }, false)
  const r2 = await tfPost(
    key,
    r1.session,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: targs } },
    true,
  )
  if (r2.json.error) throw new Error(`tinyfish ${tool}: ${JSON.stringify(r2.json.error)}`)
  return r2.json.result
}

// Extract structured content from an upstream MCP CallToolResult, best-effort.
function upstreamJson(result: any): any {
  const text = (result?.content ?? [])
    .map((c: any) => c?.text ?? "")
    .join("\n")
    .trim()
  if (!text) throw new Error("tinyfish: empty response")
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`tinyfish: non-JSON response (${text.slice(0, 120)}…)`)
  }
}

function findResultsArray(data: any): any[] {
  for (const k of ["results", "organic", "data", "web", "hits", "items"]) {
    if (Array.isArray(data?.[k])) return data[k]
  }
  if (Array.isArray(data)) return data
  return []
}

export async function tinyfishSearchN(args: any, key: string): Promise<{ provider: string; results: SearchResult[] }> {
  const targs: Record<string, any> = { query: String(args?.query ?? "") }
  if (args?.recency) targs.recency = String(args.recency)
  if (Array.isArray(args?.include_domains) && args.include_domains.length) targs.domains = args.include_domains
  const data = upstreamJson(await tfCallTool(key, "search", targs))
  const arr = findResultsArray(data)
  if (arr.length === 0) throw new Error("tinyfish search: no results in response")
  const results: SearchResult[] = arr.map((r: any) => ({
    title: r?.title ?? r?.name ?? "",
    url: r?.url ?? r?.link ?? "",
    snippet: truncate(r?.snippet ?? r?.description ?? r?.content ?? r?.text, 4000),
  }))
  return { provider: "tinyfish", results }
}

export async function tinyfishScrapeN(args: any, key: string): Promise<{ provider: string; results: ScrapeResult[] }> {
  const urls: string[] = args?.urls
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("tinyfish scrape: urls[] required")
  const targs: Record<string, any> = { urls, format: "markdown" }
  const data = upstreamJson(await tfCallTool(key, "fetch_content", targs))
  const arr = findResultsArray(data)
  if (arr.length === 0) {
    // single-URL raw text fallback
    const raw = (data?.content ?? JSON.stringify(data)) as string
    return { provider: "tinyfish", results: [{ url: urls[0], content: truncate(raw) }] }
  }
  const results: ScrapeResult[] = arr.map((r: any) => ({
    url: r?.url ?? "",
    title: r?.title,
    content: truncate(r?.content ?? r?.text ?? r?.markdown ?? ""),
  }))
  if (results.some((r) => !r.content)) throw new Error("tinyfish scrape: empty content")
  return { provider: "tinyfish", results }
}

// ---------------------------------------------------------------------------
// DuckDuckGo — keyless HTML search (last-resort fallback)
// ---------------------------------------------------------------------------

const DDG_HTML = "https://html.duckduckgo.com/html/"
const DDG_LITE = "https://lite.duckduckgo.com/lite/"

function ddgBaseHeaders(cookie?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": BROWSER_UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "same-origin",
    "Referer": DDG_HTML,
  }
  if (cookie) h["Cookie"] = cookie
  return h
}

// Warm up a cookie jar: DDG's html endpoint anomalies on cold POSTs.
async function ddgCookies(): Promise<string> {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 10_000)
    try {
      const res = await fetch(DDG_HTML, { headers: ddgBaseHeaders(), signal: ac.signal })
      const anyRes = res as any
      const jars: string[] = anyRes.headers.getSetCookie?.() ?? []
      return jars.map((c) => c.split(";")[0]).join("; ")
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return ""
  }
}

function ddgDateFilter(recency?: string): string | null {
  switch (recency) {
    case "day":
      return "d"
    case "week":
      return "w"
    case "month":
      return "m"
    case "year":
      return "y"
    default:
      return null
  }
}

function ddgQuery(args: any): string {
  let q = String(args?.query ?? "")
  const inc: string[] = Array.isArray(args?.include_domains) ? args.include_domains : []
  const exc: string[] = Array.isArray(args?.exclude_domains) ? args.exclude_domains : []
  if (inc.length) q += ` (${inc.map((d) => `site:${d}`).join(" OR ")})`
  if (exc.length) q += ` -(${exc.map((d) => `site:${d}`).join(" OR ")})`
  return q
}

function ddgDecodeHref(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) return href
  const m = href.match(/[?&]uddg=([^&]+)/)
  if (m) {
    try {
      return decodeURIComponent(m[1])
    } catch {
      return m[1]
    }
  }
  return href
}

function parseHtmlResults(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const resultRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const titles: string[] = []
  const hrefs: string[] = []
  let m: RegExpExecArray | null
  while ((m = resultRe.exec(html)) && titles.length < 10) {
    hrefs.push(ddgDecodeHref(m[1]))
    titles.push(decodeEntities(stripTags(m[2])))
  }
  const snippets: string[] = []
  while ((m = snippetRe.exec(html)) && snippets.length < 10) {
    snippets.push(decodeEntities(stripTags(m[1])))
  }
  for (let i = 0; i < titles.length; i++) {
    results.push({ title: titles[i], url: hrefs[i], snippet: truncate(snippets[i] ?? "", 4000) })
  }
  return results
}

function parseLiteResults(html: string): SearchResult[] {
  const results: SearchResult[] = []
  const linkRe = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /class="?result-snippet"?[^>]*>([\s\S]*?)<\/td>/g
  const titles: string[] = []
  const hrefs: string[] = []
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) && titles.length < 10) {
    hrefs.push(ddgDecodeHref(m[1]))
    titles.push(decodeEntities(stripTags(m[2])))
  }
  const snippets: string[] = []
  while ((m = snippetRe.exec(html)) && snippets.length < 10) {
    snippets.push(decodeEntities(stripTags(m[1])))
  }
  for (let i = 0; i < titles.length; i++) {
    results.push({ title: titles[i], url: hrefs[i], snippet: truncate(snippets[i] ?? "", 4000) })
  }
  return results
}

function isAnomaly(html: string): boolean {
  return /anomaly|unusual traffic|captcha|challenge/i.test(html.slice(0, 5000))
}

export async function ddgSearchN(args: any): Promise<{ provider: string; results: SearchResult[] }> {
  const q = ddgQuery(args)
  const df = ddgDateFilter(args?.recency)
  const cookie = await ddgCookies()
  const errors: string[] = []

  // 1) html endpoint (POST, like the browser form)
  {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const params = new URLSearchParams({ q })
      if (df) params.set("df", df)
      const headers = { ...ddgBaseHeaders(cookie), "Content-Type": "application/x-www-form-urlencoded" }
      const res = await fetch(DDG_HTML, { method: "POST", headers, body: params.toString(), signal: ac.signal })
      const html = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (isAnomaly(html)) throw new Error("anomaly page")
      const results = parseHtmlResults(html)
      if (results.length > 0) return { provider: "duckduckgo", results }
      throw new Error("no results parsed")
    } catch (e: any) {
      if (e?.name === "AbortError") errors.push("html: timeout")
      else errors.push(`html: ${String(e?.message ?? e)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  // 2) lite endpoint (GET, different page, often spared when html is flagged)
  {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const url = new URL(DDG_LITE)
      url.searchParams.set("q", q)
      if (df) url.searchParams.set("df", df)
      const res = await fetch(url.toString(), { headers: ddgBaseHeaders(cookie), signal: ac.signal })
      const html = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (isAnomaly(html)) throw new Error("anomaly page")
      const results = parseLiteResults(html)
      if (results.length > 0) return { provider: "duckduckgo", results }
      throw new Error("no results parsed")
    } catch (e: any) {
      if (e?.name === "AbortError") errors.push("lite: timeout")
      else errors.push(`lite: ${String(e?.message ?? e)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  throw new Error(`duckduckgo: ${errors.join("; ")}`)
}

// ---------------------------------------------------------------------------
// Direct fetch — keyless URL scraping (last-resort fallback)
// ---------------------------------------------------------------------------

export async function directScrapeN(args: any): Promise<{ provider: string; results: ScrapeResult[] }> {
  const urls: string[] = args?.urls
  if (!Array.isArray(urls) || urls.length === 0) throw new Error("direct scrape: urls[] required")
  if (urls.length > 3) throw new Error("direct scrape: max 3 urls (unpaid fallback)")
  const results: ScrapeResult[] = []
  for (const url of urls.slice(0, 3)) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.8" },
        redirect: "follow",
        signal: ac.signal,
      })
      const body = await res.text()
      if (!res.ok) throw new Error(`direct ${url}: HTTP ${res.status}`)
      const ctype = res.headers.get("content-type") ?? ""
      const content = /html/i.test(ctype) ? htmlToText(body) : truncate(body)
      results.push({ url, content })
    } catch (e: any) {
      if (e?.name === "AbortError") throw new Error(`direct ${url}: timed out`)
      throw new Error(`direct ${url}: ${String(e?.message ?? e)}`)
    } finally {
      clearTimeout(timer)
    }
  }
  return { provider: "direct", results }
}
