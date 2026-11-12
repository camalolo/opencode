// Unified websearch tools with provider fallback chains.
//
//   search: tavily → tinyfish → exa → duckduckgo (keyless)
//   scrape: tavily → tinyfish → exa → direct fetch (keyless)
//
// A provider is skipped if its key is missing; a provider that errors
// (quota, auth, timeout, empty) is logged to stderr and the next one runs.
// SEARCH_MCP_CHAIN env (comma-separated) overrides the provider order.
import { loadKeys } from "./providers.ts"
import {
  tavilySearchN,
  tavilyScrapeN,
  exaSearchN,
  exaScrapeN,
  tinyfishSearchN,
  tinyfishScrapeN,
  ddgSearchN,
  directScrapeN,
} from "./providers.ts"

const KEYS = loadKeys()

const ALL_PROVIDERS = ["tavily", "tinyfish", "exa", "duckduckgo"] as const

function chainFromEnv(): string[] {
  const raw = process.env.SEARCH_MCP_CHAIN?.trim()
  if (!raw) return [...ALL_PROVIDERS]
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => (ALL_PROVIDERS as readonly string[]).includes(s))
  return names.length > 0 ? names : [...ALL_PROVIDERS]
}

const SEARCH_CHAIN = chainFromEnv()

type SearchArgs = Record<string, any>
type ScrapeArgs = { urls?: string[] } & Record<string, any>
type Normalized = { provider: string; results: any[] }

type SearchProvider = { name: string; key?: string | null; run: (args: SearchArgs, key: string) => Promise<Normalized> }
type ScrapeProvider = { name: string; key?: string | null; run: (args: ScrapeArgs, key: string) => Promise<Normalized> }

const SEARCH_PROVIDERS: SearchProvider[] = [
  { name: "tavily", key: KEYS.tavily, run: (a, k) => tavilySearchN(a, k) },
  { name: "tinyfish", key: KEYS.tinyfish, run: (a, k) => tinyfishSearchN(a, k) },
  { name: "exa", key: KEYS.exa, run: (a, k) => exaSearchN(a, k) },
  { name: "duckduckgo", run: (a) => ddgSearchN(a) },
]

const SCRAPE_PROVIDERS: ScrapeProvider[] = [
  { name: "tavily", key: KEYS.tavily, run: (a, k) => tavilyScrapeN(a, k) },
  { name: "tinyfish", key: KEYS.tinyfish, run: (a, k) => tinyfishScrapeN(a, k) },
  { name: "exa", key: KEYS.exa, run: (a, k) => exaScrapeN(a, k) },
  { name: "direct", run: (a) => directScrapeN(a) },
]

async function runChain(providers: { name: string; key?: string | null; run: any }[], args: any): Promise<Normalized> {
  const errors: string[] = []
  for (const p of providers) {
    if (p.key !== undefined && !p.key) {
      errors.push(`${p.name}: no API key`)
      continue
    }
    try {
      return await p.run(args, p.key!)
    } catch (e: any) {
      const msg = `${p.name}: ${String(e?.message ?? e)}`
      errors.push(msg)
      console.error(`search-mcp fallback: ${msg}`)
    }
  }
  throw new Error(`all providers failed:\n  - ${errors.join("\n  - ")}`)
}

export async function websearchSearch(args: SearchArgs): Promise<Normalized> {
  const enabled = SEARCH_PROVIDERS.filter((p) => SEARCH_CHAIN.includes(p.name))
  return runChain(enabled.length > 0 ? enabled : SEARCH_PROVIDERS, args)
}

export async function websearchScrape(args: ScrapeArgs): Promise<Normalized> {
  const enabled = SCRAPE_PROVIDERS.filter(
    (p) => SEARCH_CHAIN.includes(p.name) || p.name === "direct",
  )
  return runChain(enabled.length > 0 ? enabled : SCRAPE_PROVIDERS, args)
}

export function chainStatus() {
  return {
    chain: SEARCH_CHAIN,
    keys: { tavily: !!KEYS.tavily, exa: !!KEYS.exa, tinyfish: !!KEYS.tinyfish },
  }
}
