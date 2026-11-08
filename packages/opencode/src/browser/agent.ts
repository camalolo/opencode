export * as BrowserAgent from "./agent"

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import { homedir, tmpdir } from "node:os"
import { BrowserDaemon } from "./daemon"

const PAGE_TEXT_LIMIT = 20000
const LIST_LIMIT = 50
const POLL_MS = 500
const DOWNLOADS_DIR = join(homedir(), ".opencode-browser", "downloads")

// Tab ownership lives in this process: one daemon per server, one opencode
// server process per server, so a Map is the whole registry.
const claims = new Map<number, string>()

export function listClaims(): { tabId: number; owner: string }[] {
  return [...claims.entries()].map(([tabId, owner]) => ({ tabId, owner }))
}

export function claimTab(
  tabId: number,
  owner: string,
  force?: boolean,
): { tabId: number; owner: string } | { tabId: number; owner: string; conflict: true } {
  const current = claims.get(tabId)
  if (current && current !== owner && !force) return { tabId, owner: current, conflict: true }
  claims.set(tabId, owner)
  return { tabId, owner }
}

export function releaseTab(tabId: number, owner?: string): { tabId: number; released: boolean } {
  const current = claims.get(tabId)
  if (!current) return { tabId, released: false }
  if (owner && current !== owner) return { tabId, released: false }
  claims.delete(tabId)
  return { tabId, released: true }
}

const downloads: { path: string; filename?: string; url?: string; timestamp: string }[] = []

function recordDownload(entry: { path: string; filename?: string; url?: string }) {
  downloads.unshift({ ...entry, timestamp: new Date().toISOString() })
  if (downloads.length > 50) downloads.length = 50
}

function resolveDownloadPath(filename?: string, url?: string): string {
  let name = typeof filename === "string" ? filename.trim() : ""
  if (!name && typeof url === "string") {
    try {
      name = basename(new URL(url).pathname) || ""
    } catch {}
  }
  if (!name) name = `download-${Date.now()}`
  const fullPath = isAbsolute(name) ? name : join(DOWNLOADS_DIR, name)
  mkdirSync(dirname(fullPath), { recursive: true })
  return fullPath
}

function numberArg(value: unknown): number | null {
  return Number.isFinite(value) ? Number(value) : null
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

async function withTab(tabId: unknown, action: () => Promise<{ content: string | object }>): Promise<{ content: string | object }> {
  const index = numberArg(tabId)
  if (index === null) return await action()
  await BrowserDaemon.command("tab_switch", { index })
  return await action()
}

async function evaluate(script: string): Promise<any> {
  const data = await BrowserDaemon.command("evaluate", { script })
  return data?.result
}

async function waitForCount(selector: string, minimum: number, timeoutMs: number, pollMs: number): Promise<number> {
  const timeout = Math.max(0, timeoutMs)
  const poll = Math.max(0, pollMs || POLL_MS)
  const start = Date.now()
  while (true) {
    const data = await BrowserDaemon.command("count", { selector })
    const count = Number(data?.count ?? 0)
    if (count >= minimum) return count
    if (!timeout || Date.now() - start >= timeout) return count
    await new Promise((resolve) => setTimeout(resolve, poll))
  }
}

function evalScript(body: string): string {
  return `(() => { ${body} })()`
}

function typeScript(selector: string, index: number, text: string, clear: boolean): string {
  const payload = JSON.stringify({ selector, index, text, clear })
  return evalScript(`
    const payload = ${payload};
    let matches = [];
    try { matches = Array.from(document.querySelectorAll(payload.selector)); } catch { return { ok: false, error: "Invalid selector" }; }
    const element = matches[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    const tag = element.tagName ? element.tagName.toUpperCase() : "";
    if (tag === "INPUT" || tag === "TEXTAREA") {
      if (payload.clear) element.value = "";
      element.value = (element.value || "") + payload.text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true };
    }
    if (element.isContentEditable) {
      if (payload.clear) element.textContent = "";
      element.textContent = (element.textContent || "") + payload.text;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      return { ok: true };
    }
    return { ok: false, error: "Element is not typable" };
  `)
}

function selectScript(selector: string, index: number, value: string | undefined, label: string | undefined, optionIndex: number | null): string {
  const payload = JSON.stringify({ selector, index, value: value ?? null, label: label ?? null, optionIndex })
  return evalScript(`
    const payload = ${payload};
    let matches = [];
    try { matches = Array.from(document.querySelectorAll(payload.selector)); } catch { return { ok: false, error: "Invalid selector" }; }
    const element = matches[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    if (!element.tagName || element.tagName.toUpperCase() !== "SELECT") return { ok: false, error: "Element is not a select" };
    const options = Array.from(element.options || []);
    let chosen = null;
    if (payload.value !== null) chosen = options.find((option) => option.value === payload.value) || null;
    if (!chosen && payload.label !== null) {
      const target = payload.label.trim();
      chosen = options.find((option) => (option.label || option.textContent || "").trim() === target) || null;
    }
    if (!chosen && payload.optionIndex !== null) chosen = options[payload.optionIndex] || null;
    if (!chosen) return { ok: false, error: "Option not found" };
    element.value = chosen.value;
    chosen.selected = true;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, value: element.value, label: (chosen.label || chosen.textContent || "").trim() };
  `)
}

function pageTextScript(limit: number, pattern: string | null, flags: string): string {
  const payload = JSON.stringify({ limit, pattern, flags })
  return evalScript(`
    const payload = ${payload};
    const safeString = (value) => (typeof value === "string" ? value : "");
    const bodyText = safeString(document.body ? document.body.innerText : "");
    const inputText = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"))
      .map((element) => {
        if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") return safeString(element.value);
        return safeString(element.textContent);
      })
      .filter(Boolean)
      .join("\\n");
    const combined = [bodyText, inputText].filter(Boolean).join("\\n\\n");
    const maxSize = Number.isFinite(payload.limit) ? payload.limit : ${PAGE_TEXT_LIMIT};
    const text = combined.slice(0, Math.max(0, maxSize));
    let matches = [];
    if (payload.pattern) {
      try {
        const re = new RegExp(payload.pattern, payload.flags || "i");
        let match;
        while ((match = re.exec(text)) && matches.length < 50) {
          matches.push(match[0]);
          if (!re.global) break;
        }
      } catch { matches = []; }
    }
    return { url: location.href, title: document.title, text, matches };
  `)
}

function listScript(selector: string, limit: number): string {
  const payload = JSON.stringify({ selector, limit })
  return evalScript(`
    const payload = ${payload};
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(payload.selector)); } catch { return { ok: false, error: "Invalid selector" }; }
    const maxItems = Math.min(Math.max(1, payload.limit || ${LIST_LIMIT}), 200);
    const items = nodes.slice(0, maxItems).map((element) => ({
      text: (element.innerText || element.textContent || "").trim().slice(0, 200),
      tag: (element.tagName || "").toLowerCase(),
      ariaLabel: element.getAttribute ? element.getAttribute("aria-label") : null,
    }));
    return { ok: true, value: { items, count: nodes.length } };
  `)
}

function highlightScript(selector: string, index: number, color: string, durationMs: number, showInfo: boolean): string {
  const payload = JSON.stringify({ selector, index, color, durationMs, showInfo })
  return evalScript(`
    const payload = ${payload};
    let matches = [];
    try { matches = Array.from(document.querySelectorAll(payload.selector)); } catch { return { ok: false, error: "Invalid selector" }; }
    const element = matches[payload.index];
    if (!element) return { ok: false, error: "Element not found", matched: matches.length };
    const rect = element.getBoundingClientRect();
    const previous = element.getAttribute("style") || "";
    element.style.outline = "2px solid " + payload.color;
    element.style.outlineOffset = "1px";
    let info = null;
    if (payload.showInfo) {
      info = document.createElement("div");
      info.textContent = payload.selector + " " + Math.round(rect.width) + "x" + Math.round(rect.height);
      info.style.cssText = "position:fixed;z-index:2147483647;top:" + Math.max(0, rect.top - 18) + "px;left:" + Math.max(0, rect.left) + "px;background:" + payload.color + ";color:#fff;font:12px monospace;padding:2px 5px;border-radius:3px;pointer-events:none;";
      document.documentElement.appendChild(info);
    }
    setTimeout(() => {
      if (previous) element.setAttribute("style", previous); else element.removeAttribute("style");
      if (info) info.remove();
    }, payload.durationMs);
    return { ok: true, matched: matches.length, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }, durationMs: payload.durationMs };
  `)
}

function nthScript(kind: "value" | "attribute" | "property" | "html", selector: string, index: number, key?: string): string {
  const payload = JSON.stringify({ selector, index, key: key ?? null })
  const readValue =
    kind === "value"
      ? "const value = element.value !== undefined ? element.value : \"\"; return { ok: true, value: typeof value === \"string\" ? value : String(value ?? \"\") };"
      : kind === "attribute"
        ? "return { ok: true, value: element.getAttribute ? element.getAttribute(payload.key) : null };"
        : kind === "property"
          ? "return { ok: true, value: element[payload.key] };"
          : "return { ok: true, value: element.outerHTML };"
  return evalScript(`
    const payload = ${payload};
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll(payload.selector)); } catch { return { ok: false, error: "Invalid selector" }; }
    const element = nodes[payload.index];
    if (!element) return { ok: false, error: "Element not found" };
    ${readValue}
  `)
}

function ensureEvalResult(result: any, fallback: string): any {
  if (!result || typeof result !== "object" || result.ok !== true) {
    throw new Error(typeof result?.error === "string" ? result.error : fallback)
  }
  return result.value
}

async function query(args: any): Promise<{ content: string | object }> {
  const selector = stringArg(args.selector)
  const mode = stringArg(args.mode) || "text"
  const index = numberArg(args.index) ?? 0
  const limit = numberArg(args.limit) ?? (mode === "page_text" ? PAGE_TEXT_LIMIT : LIST_LIMIT)
  const timeout = numberArg(args.timeoutMs) ?? 0
  const poll = numberArg(args.pollMs) ?? POLL_MS
  const pattern = stringArg(args.pattern) ?? null
  const flags = stringArg(args.flags) ?? "i"
  if (mode === "page_text") {
    if (selector && timeout > 0) await waitForCount(selector, 1, timeout, poll)
    const pageText = await evaluate(pageTextScript(limit, pattern, flags))
    return { content: JSON.stringify({ ok: true, value: pageText }, null, 2) }
  }
  if (!selector) throw new Error("selector is required")
  if (mode === "exists") {
    const count = await waitForCount(selector, 1, timeout, poll)
    return { content: JSON.stringify({ ok: true, value: { exists: count > 0, count } }, null, 2) }
  }
  const count = await waitForCount(selector, index + 1, timeout, poll)
  if (count <= index) throw new Error(`No matches for selector: ${selector}`)
  if (mode === "text") {
    const data =
      index > 0
        ? await BrowserDaemon.command("nth", { selector, index, subaction: "text" })
        : await BrowserDaemon.command("innertext", { selector })
    return { content: typeof data?.text === "string" ? data.text : "" }
  }
  if (mode === "value") {
    if (index > 0) {
      const value = ensureEvalResult(await evaluate(nthScript("value", selector, index)), "Value lookup failed")
      return { content: typeof value === "string" ? value : JSON.stringify(value) }
    }
    const data = await BrowserDaemon.command("inputvalue", { selector })
    return { content: typeof data?.value === "string" ? data.value : "" }
  }
  if (mode === "attribute") {
    if (!args.attribute) throw new Error("attribute is required")
    if (index > 0) {
      const value = ensureEvalResult(await evaluate(nthScript("attribute", selector, index, stringArg(args.attribute))), "Attribute lookup failed")
      return { content: typeof value === "string" ? value : JSON.stringify(value) }
    }
    const data = await BrowserDaemon.command("getattribute", { selector, attribute: args.attribute })
    return { content: typeof data?.value === "string" ? data.value : JSON.stringify(data?.value) }
  }
  if (mode === "property") {
    if (!args.property) throw new Error("property is required")
    const value = ensureEvalResult(await evaluate(nthScript("property", selector, index, stringArg(args.property))), "Property lookup failed")
    return { content: typeof value === "string" ? value : JSON.stringify(value) }
  }
  if (mode === "html") {
    const value = ensureEvalResult(await evaluate(nthScript("html", selector, index)), "HTML lookup failed")
    return { content: typeof value === "string" ? value : JSON.stringify(value) }
  }
  if (mode === "list") {
    const value = ensureEvalResult(await evaluate(listScript(selector, limit)), "List lookup failed")
    return { content: JSON.stringify({ ok: true, value }, null, 2) }
  }
  throw new Error(`Unknown mode: ${mode}`)
}

async function download(args: any): Promise<{ content: string | object }> {
  const url = (stringArg(args.url) ?? "").trim()
  const selector = (stringArg(args.selector) ?? "").trim()
  const filename = (stringArg(args.filename) ?? "").trim()
  const timeout = numberArg(args.downloadTimeoutMs) ?? 120_000
  if (!url && !selector) throw new Error("url or selector is required")
  if (url && selector) throw new Error("Provide either url or selector, not both")
  // URL downloads are fetched server-side: the daemon's browser-managed
  // downloads get canceled by headless Chrome-for-Testing, so the browser
  // path is reserved for clicks that need the page's session context.
  if (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout) })
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} for ${url}`)
    let name = filename
    if (!name) {
      try {
        name = basename(new URL(res.url || url).pathname)
      } catch {}
    }
    if (!name || name === "/") name = `download-${Date.now()}`
    const path = resolveDownloadPath(name)
    await Bun.write(path, res)
    const entry = { path, filename: name, url, size: statSync(path).size }
    recordDownload(entry)
    return { content: JSON.stringify({ ok: true, ...entry }, null, 2) }
  }
  return await withTab(args.tabId, async () => {
    if (!args.wait) {
      await BrowserDaemon.command("click", { selector })
      return { content: JSON.stringify({ ok: true, started: true, selector }, null, 2) }
    }
    const path = resolveDownloadPath(filename || undefined)
    const data = await BrowserDaemon.command("download", { selector, path })
    const entry = {
      path: String(data?.path || path),
      filename: typeof data?.suggestedFilename === "string" ? data.suggestedFilename : undefined,
    }
    recordDownload(entry)
    return { content: JSON.stringify({ ok: true, ...entry }, null, 2) }
  })
}

// Raw-CDP endpoint discovery from the DevToolsActivePort markers the daemon's
// chromium writes under tmpdir. Port/UUIDs change on every browser relaunch.
async function cdpEndpoint(): Promise<{ content: string | object }> {
  const candidates: { marker: string; mtimeMs: number }[] = []
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith("agent-browser-chrome-")) continue
    const marker = join(tmpdir(), entry, "DevToolsActivePort")
    try {
      candidates.push({ marker, mtimeMs: statSync(marker).mtimeMs })
    } catch {}
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  let endpoint: { port: number; browserWs: string; httpBase: string } | null = null
  let version: string | null = null
  for (const candidate of candidates) {
    const [port, browserPath] = readFileSync(candidate.marker, "utf8").trim().split("\n")
    const probe = {
      port: Number(port),
      browserWs: `ws://127.0.0.1:${port}${browserPath ?? ""}`,
      httpBase: `http://127.0.0.1:${port}`,
    }
    try {
      const res = await fetch(`${probe.httpBase}/json/version`, { signal: AbortSignal.timeout(1500) })
      if (!res.ok) continue
      version = (await res.json()).Browser
      endpoint = probe
      break
    } catch {}
  }
  if (!endpoint) {
    throw new Error(
      `No live CDP endpoint among ${candidates.length} DevToolsActivePort markers under ${tmpdir()}/agent-browser-chrome-*; the automation browser is not running`,
    )
  }
  return {
    content: JSON.stringify({
      ...endpoint,
      version,
      note: "Raw CDP access. Re-run before every attach: port and UUIDs change on every browser relaunch (daemon recycles ~6h). Never send an Origin header (rejected with 403). Page list: GET httpBase + /json/list. Attach browser-level via browserWs.",
    }),
  }
}

// Port of the plugin's agent-backend tool dispatcher. `sessionID` scopes tab
// claims; everything else is daemon-state based.
export async function run(tool: string, args: any, sessionID: string): Promise<{ content: string | object }> {
  switch (tool) {
    case "get_tabs": {
      const data = await BrowserDaemon.command("tab_list", {})
      const tabs = Array.isArray(data?.tabs) ? data.tabs : []
      return {
        content: JSON.stringify(
          tabs.map((tab: any) => ({ id: tab.index, url: tab.url, title: tab.title, active: tab.active, windowId: tab.windowId ?? 0 })),
          null,
          2,
        ),
      }
    }
    case "list_downloads":
      return { content: JSON.stringify({ downloads }, null, 2) }
    case "open_tab": {
      const active = args.active
      let previousActive: number | null = null
      if (active === false) {
        const list = await BrowserDaemon.command("tab_list", {})
        if (Number.isFinite(list?.active)) previousActive = Number(list.active)
      }
      const created = await BrowserDaemon.command("tab_new", {})
      if (args.url) await BrowserDaemon.command("navigate", { url: args.url })
      if (active === false && previousActive !== null) await BrowserDaemon.command("tab_switch", { index: previousActive })
      return { content: { tabId: created.index, url: args.url, active: active !== false } }
    }
    case "close_tab": {
      const payload: Record<string, unknown> = {}
      const index = numberArg(args.tabId)
      if (index !== null) payload.index = index
      const result = await BrowserDaemon.command("tab_close", payload)
      const closed = Number.isFinite(result?.closed) ? Number(result.closed) : args.tabId
      return { content: { tabId: closed, remaining: result?.remaining } }
    }
    case "navigate":
      return await withTab(args.tabId, async () => {
        if (!args.url) throw new Error("URL is required")
        await BrowserDaemon.command("navigate", { url: args.url })
        return { content: `Navigated to ${args.url}` }
      })
    case "download":
      return await download(args)
    case "click":
      return await withTab(args.tabId, async () => {
        if (!args.selector) throw new Error("Selector is required")
        const index = numberArg(args.index) ?? 0
        if (index) await BrowserDaemon.command("nth", { selector: args.selector, index, subaction: "click" })
        else await BrowserDaemon.command("click", { selector: args.selector })
        return { content: `Clicked ${args.selector}` }
      })
    case "type":
      return await withTab(args.tabId, async () => {
        if (!args.selector) throw new Error("Selector is required")
        if (args.text === undefined) throw new Error("Text is required")
        const index = numberArg(args.index) ?? 0
        if (!index) {
          await BrowserDaemon.command("type", { selector: args.selector, text: String(args.text), clear: args.clear })
        } else {
          const result = await evaluate(typeScript(args.selector, index, String(args.text), !!args.clear))
          if (!result?.ok) throw new Error(result?.error || "Type failed")
        }
        return { content: `Typed "${args.text}" into ${args.selector}` }
      })
    case "select":
      return await withTab(args.tabId, async () => {
        if (!args.selector) throw new Error("Selector is required")
        if (args.value === undefined && args.label === undefined && args.optionIndex === undefined) {
          throw new Error("value, label, or optionIndex is required")
        }
        const index = numberArg(args.index) ?? 0
        let selectedValue = args.value
        let selectedLabel = args.label
        if (index || args.label !== undefined || args.optionIndex !== undefined) {
          const result = await evaluate(
            selectScript(args.selector, index, stringArg(args.value), stringArg(args.label), numberArg(args.optionIndex)),
          )
          if (!result?.ok) throw new Error(result?.error || "Select failed")
          selectedValue = result.value
          selectedLabel = result.label
        } else if (args.value !== undefined) {
          await BrowserDaemon.command("select", { selector: args.selector, values: args.value })
        }
        const valueText = selectedValue ? String(selectedValue) : ""
        const labelText = selectedLabel ? String(selectedLabel) : ""
        const summary = labelText && valueText && labelText !== valueText ? `${labelText} (${valueText})` : labelText || valueText || "option"
        return { content: `Selected ${summary} in ${args.selector}` }
      })
    case "set_file_input":
      return await withTab(args.tabId, async () => {
        if (!args.selector) throw new Error("Selector is required")
        const rawPath = String(args.filePath ?? "").trim()
        if (!rawPath) throw new Error("filePath is required")
        const absPath = isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath)
        if (!existsSync(absPath)) throw new Error(`File not found: ${absPath}`)
        // The daemon expects files as an array; a bare string attaches zero files.
        const data = await BrowserDaemon.command("upload", { selector: args.selector, files: [absPath] })
        const uploaded = Number(data?.uploaded ?? 0)
        if (uploaded < 1) throw new Error(`Attached 0 files to ${args.selector} — verify the selector matches an <input type="file">`)
        return {
          content: JSON.stringify({ ok: true, selector: args.selector, uploaded }, null, 2),
        }
      })
    case "screenshot":
      return await withTab(args.tabId, async () => {
        const data = await BrowserDaemon.command("screenshot", { format: "png" })
        let base64 = data?.base64 ? String(data.base64) : ""
        // Current daemon versions save to a file instead of returning base64.
        if (!base64 && typeof data?.path === "string" && data.path) base64 = readFileSync(data.path).toString("base64")
        if (!base64) throw new Error("Screenshot failed")
        return { content: `data:image/png;base64,${base64}` }
      })
    case "snapshot":
      return await withTab(args.tabId, async () => {
        const data = await BrowserDaemon.command("snapshot", {})
        return { content: JSON.stringify({ snapshot: data?.snapshot ?? "", refs: data?.refs ?? {} }, null, 2) }
      })
    case "query":
      return await withTab(args.tabId, async () => await query(args))
    case "scroll":
      return await withTab(args.tabId, async () => {
        const x = numberArg(args.x) ?? 0
        const y = numberArg(args.y) ?? 0
        await BrowserDaemon.command("scroll", { selector: args.selector, x, y })
        return { content: `Scrolled ${args.selector ? `to ${args.selector}` : `by (${x}, ${y})`}` }
      })
    case "wait":
      return await withTab(args.tabId, async () => {
        const ms = numberArg(args.ms) ?? 1000
        await BrowserDaemon.command("wait", { timeout: ms })
        return { content: `Waited ${ms}ms` }
      })
    case "console":
      return await withTab(args.tabId, async () => {
        const data = await BrowserDaemon.command("console", { clear: args.clear })
        let messages: any[] = data?.messages ?? []
        const filter = stringArg(args.filter)
        if (filter) {
          const needle = filter.toLowerCase()
          messages = messages.filter((message) => `${message?.type ?? ""} ${message?.text ?? ""}`.toLowerCase().includes(needle))
        }
        return { content: JSON.stringify(messages) }
      })
    case "errors":
      return await withTab(args.tabId, async () => {
        const data = await BrowserDaemon.command("errors", { clear: args.clear })
        return { content: JSON.stringify(data?.errors ?? []) }
      })
    case "highlight":
      return await withTab(args.tabId, async () => {
        if (!args.selector) throw new Error("Selector is required")
        const index = numberArg(args.index) ?? 0
        if ((numberArg(args.timeoutMs) ?? 0) > 0) {
          await waitForCount(args.selector, index + 1, numberArg(args.timeoutMs)!, numberArg(args.pollMs) ?? POLL_MS)
        }
        const result = await evaluate(
          highlightScript(args.selector, index, stringArg(args.color) ?? "#ff0000", numberArg(args.duration) ?? 2000, args.showInfo !== false),
        )
        if (!result?.ok) throw new Error(result?.error || `Highlight failed (${result?.matched ?? 0} matches for ${args.selector})`)
        return { content: JSON.stringify({ ok: true, selector: args.selector, ...result }, null, 2) }
      })
    case "cdp":
      return await cdpEndpoint()
    default:
      throw new Error(`Unsupported tool for agent backend: ${tool}`)
  }
}
