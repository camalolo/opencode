// search-mcp tool definitions and dispatch: 2 unified tools.
import { websearchSearch, websearchScrape, chainStatus } from "./websearch.ts"

export type ToolDef = {
  name: string
  description: string
  inputSchema: Schema
  handler: (args: any) => Promise<any>
}

// Minimal JSON-Schema shape (no type packages for a zero-dep project)
type Schema = {
  type: string
  properties?: Record<string, any>
  required?: string[]
  items?: any
  additionalProperties?: boolean
  description?: string
}

function obj(
  properties: Record<string, Schema>,
  required: string[] = [],
): Schema {
  return { type: "object", properties, required, additionalProperties: false }
}

const s = (description: string): Schema => ({ type: "string", description })
const strArr = (description: string): Schema => ({
  type: "array",
  items: { type: "string" },
  description,
})

const PROVIDER_ENUM: Schema = {
  type: "string",
  description:
    "Force a specific provider (skips the fallback chain). Default: automatic fallback.",
  enum: ["tavily", "tinyfish", "exa", "duckduckgo"],
}

const CHAIN_NOTE =
  "Provider fallback chain: tavily → tinyfish → exa → duckduckgo. " +
  "The response reports which provider actually served the request in `provider`."

export const TOOLS: ToolDef[] = [
  {
    name: "search",
    description: `Web search with automatic provider fallback. ${CHAIN_NOTE}`,
    inputSchema: obj(
      {
        query: s("The search query"),
        max_results: {
          type: "number",
          description: "Maximum results (default 5, max 10)",
        },
        recency: s("'day' | 'week' | 'month' | 'year'"),
        include_domains: strArr("Only search within these domains"),
        exclude_domains: strArr("Exclude these domains"),
        provider: PROVIDER_ENUM,
      },
      ["query"],
    ),
    handler: (args) => websearchSearch(args),
  },
  {
    name: "scrape",
    description: `Fetch clean page content for 1-10 URLs with automatic provider fallback (tavily → tinyfish → exa → direct fetch). The response reports which provider served it.`,
    inputSchema: obj(
      {
        urls: strArr("URLs to fetch (1-10)"),
        provider: PROVIDER_ENUM,
      },
      ["urls"],
    ),
    handler: (args) => websearchScrape(args),
  },
]

export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}

export async function callTool(name: string, args: any) {
  const tool = TOOLS.find((t) => t.name === name)
  if (!tool) {
    return textResult(`Unknown tool: ${name}. `, true)
  }
  try {
    const forced = args?.provider ? String(args.provider) : null
    const effective = forced ? { ...args, provider: undefined } : args
    const result = forced ? await forcedCall(tool.name, forced, effective) : await tool.handler(effective)
    return textResult(JSON.stringify(result, null, 2))
  } catch (e: any) {
    return textResult(String(e?.message ?? e), true)
  }
}

async function forcedCall(toolName: string, provider: string, args: any) {
  const { loadKeys } = await import("./providers.ts")
  const keys = loadKeys()
  const key = (keys as Record<string, string | null>)[provider]
  if (toolName === "search" && provider === "duckduckgo") {
    const { ddgSearchN } = await import("./providers.ts")
    return ddgSearchN(args)
  }
  if (toolName === "scrape" && provider === "duckduckgo") {
    const { directScrapeN } = await import("./providers.ts")
    return directScrapeN(args)
  }
  if (!key && provider !== "duckduckgo") {
    throw new Error(`provider '${provider}' has no API key configured`)
  }
  const mods: Record<string, any> = await import("./providers.ts")
  const fn = `${provider}${toolName === "search" ? "Search" : "Scrape"}N`
  return mods[fn](args, key)
}

export function keyStatus() {
  return chainStatus()
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }
}
