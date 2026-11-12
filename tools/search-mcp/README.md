# search-mcp

Zero-dependency MCP stdio server for web search + URL scraping with
**automatic provider fallback**. Runs on Bun 1.x — no npm dependencies.

The LLM sees exactly **2 tools**; if a provider is over quota, unauthorized,
or errors, the server silently falls through the chain — no wasted model
round-trips:

```
websearch_search : tavily → tinyfish → exa → duckduckgo (keyless)
websearch_scrape : tavily → tinyfish → exa → direct fetch (keyless)
```

The response JSON reports the `provider` that actually served the request.

## Tools

| Tool | Args | Behavior |
|---|---|---|
| `websearch_search` | `query` (req), `max_results` (default 5), `recency` (day/week/month/year), `include_domains[]`, `exclude_domains[]`, `provider` (force) | Normalized `{provider, results:[{title,url,snippet}]}` |
| `websearch_scrape` | `urls` (1-10, req), `provider` (force) | Normalized `{provider, results:[{url,title?,content}]}`; content capped at 60k chars/URL |

`provider` forces one backend (clean error if its key is missing) — otherwise
the fallback chain runs: missing key → skip; any error → next provider.

## Keys

Read once at startup; resolution order: env var, then the opencode auth store
(`websearch-tavily` / `websearch-exa` / `websearch-tinyfish` API entries in
`<xdg data dir>/opencode/auth.json` — these are what the opencode settings UI
writes), then a `~/.<name>` file (legacy, e.g. `~/.tavily` from the tavicli
convention):

- `TAVILY_API_KEY` or `websearch-tavily` or `~/.tavily`
- `EXA_API_KEY` or `websearch-exa` or `~/.exa`
- `TINYFISH_API_KEY` or `websearch-tinyfish` or `~/.tinyfish` (agent.tinyfish.ai/api-keys)

Missing keys don't disable the tools — the keyless fallbacks
(duckduckgo HTML search, direct fetch) always work.

`SEARCH_MCP_CHAIN=tavily,duckduckgo` (comma list) overrides the provider
order, e.g. to disable a provider host-wide.

## Run

```sh
bun run src/index.ts        # stdio MCP server
bun run test                # validation suite (live tavily/DDG/direct + fake-key fallbacks)
```

opencode runs it straight from this checkout (this repo lives at the fleet's
Sources location on every host); no build step, no binaries:

```json
{
  "mcp": {
    "websearch": {
      "type": "local",
      "command": ["bun", "<repo>/tools/search-mcp/src/index.ts"],
      "enabled": true
    }
  }
}
```

opencode tool IDs become `websearch_search` and `websearch_scrape`
(`<server>_<tool>`, McpCatalog.toolName). Do NOT set `timeout` in the mcp
entry — opencode applies that value to tool **calls** too (mcp/index.ts
requestTimeout → code-mode.ts:156) and the fallback chain can exceed 10s;
omitting it yields the SDK default 60s.

## Notes

- Protocol: newline-delimited JSON-RPC 2.0 over stdio; echoes the client's
  `protocolVersion`. stdout carries protocol only; diagnostics → stderr.
- TinyFish has no plain REST API — the server speaks a minimal MCP-client
  (initialize → tools/call) to `https://agent.tinyfish.ai/mcp` with the key
  as `X-API-Key`, one fresh session per call.
- DuckDuckGo search scrapes `html.duckduckgo.com/html/` (POST, browser UA,
  uddg redirect decoding, anomaly-page detection).
- Direct fetch strips script/style/tags, decodes entities, follows redirects.
- All upstream calls: 30s timeout; errors surface in-band as `isError` with
  a per-provider breakdown when the whole chain fails.

## Layout

```
src/index.ts      MCP stdio protocol loop + dispatch
src/tools.ts      the 2 tool schemas + forced-provider handling
src/websearch.ts  fallback chains + SEARCH_MCP_CHAIN env
src/providers.ts  tavily/exa REST, tinyfish MCP-client, ddg/direct
test/stdio-test.ts  end-to-end suite
```
