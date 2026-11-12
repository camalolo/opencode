#!/usr/bin/env bun
// search-mcp — zero-dependency MCP stdio server unifying Tavily, Exa and
// TinyFish web search/scrape APIs.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio).
// Protocol version: echoes the client's initialize request (interop-safe).
// Diagnostics go to stderr only; stdout carries protocol messages exclusively.
import readline from "node:readline"
import { listTools, callTool, keyStatus } from "./tools.ts"

const SERVER_INFO = { name: "search-mcp", version: "0.2.0" }

function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
}

function replyError(id: unknown, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n")
}

async function handleMessage(msg: any): Promise<void> {
  const hasId = msg && msg.id !== undefined && msg.id !== null
  const method: string | undefined = msg?.method
  const params = msg?.params

  switch (method) {
    case "initialize":
      if (!hasId) return
      reply(msg.id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })
      return
    case "notifications/initialized":
    case "notifications/cancelled":
    case "notifications/roots/list_changed":
      return // notifications: no response
    case "ping":
      if (hasId) reply(msg.id, {})
      return
    case "tools/list":
      if (hasId) reply(msg.id, { tools: listTools() })
      return
    case "tools/call": {
      if (!hasId) return
      const name = String(params?.name ?? "")
      const result = await callTool(name, params?.arguments ?? {})
      reply(msg.id, result)
      return
    }
    case "prompts/list":
      if (hasId) reply(msg.id, { prompts: [] })
      return
    case "resources/list":
      if (hasId) reply(msg.id, { resources: [] })
      return
    case "resources/templates/list":
      if (hasId) reply(msg.id, { resourceTemplates: [] })
      return
    case "resources/read":
      if (hasId) replyError(msg.id, -32601, "resources not supported")
      return
    case "completion/complete":
      if (hasId) reply(msg.id, { completion: { values: [], total: 0, hasMore: false } })
      return
    case "logging/setLevel":
      if (hasId) reply(msg.id, {})
      return
    default:
      if (!hasId) return // unknown notification: ignore per JSON-RPC
      replyError(msg.id, -32601, `Method not found: ${method}`)
  }
}

async function processLine(line: string): Promise<void> {
  const trimmed = line.trim()
  if (!trimmed) return
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    replyError(null, -32700, "Parse error")
    return
  }
  if (Array.isArray(parsed)) {
    for (const m of parsed) await handleMessage(m)
    return
  }
  await handleMessage(parsed)
}

async function main() {
  console.error(`search-mcp ${SERVER_INFO.version} starting; providers: ${JSON.stringify(keyStatus())}`)
  // Serialize message processing to keep responses ordered and state sane.
  let chain: Promise<void> = Promise.resolve()
  const rl = readline.createInterface({ input: process.stdin, terminal: false })
  rl.on("line", (line) => {
    chain = chain
      .then(() => processLine(line))
      .catch((e) => console.error(`search-mcp: handler error: ${e?.stack ?? e}`))
  })
  rl.on("close", () => {
    // drain in-flight work before exiting (piped/one-shot clients)
    chain.then(() => process.exit(0))
  })
  process.on("SIGINT", () => process.exit(0))
  process.on("SIGTERM", () => process.exit(0))
}

main()
