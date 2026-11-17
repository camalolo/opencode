import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import os from "os"
import path from "path"

// OAuth redirect target for local MCP servers that authenticate Google APIs
// (google-workspace). Google redirects the user's browser here after consent;
// the authorization code is handed to the waiting MCP server process through
// auth-code.json in the MCP auth directory. No auth middleware: the redirect
// arrives from Google with no server credentials, and the endpoint only
// persists a short-lived code that only the local OAuth client can exchange.
export const oauthCallbackRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    yield* router.add("GET", "/oauth/google/callback", (request) => handleCallback(request, fs))
  }),
)

function authDir(): string {
  return process.env.GOOGLE_WORKSPACE_MCP_AUTH_DIR || path.join(os.homedir(), ".google-workspace-mcp")
}

const handleCallback = (request: HttpServerRequest.HttpServerRequest, fs: FSUtil.Interface) =>
  Effect.gen(function* () {
    const url = new URL(request.url, "http://localhost")
    const code = url.searchParams.get("code")
    if (!code) {
      const reason = url.searchParams.get("error") ?? "missing code parameter"
      yield* Effect.logWarning("oauth callback failed", { error: reason })
      return page(false, `Authorization failed: ${reason}. Close this tab and retry the request in your session.`)
    }
    const dir = authDir()
    yield* fs.makeDirectory(dir, { recursive: true })
    yield* fs.writeFileString(path.join(dir, "auth-code.json"), JSON.stringify({ code, received_at: Date.now() }, null, 2))
    yield* Effect.logInfo("oauth callback received", { dir })
    return page(true, "Authorization received. You can close this tab and return to your session — retry the request and it will complete.")
  })

function page(ok: boolean, message: string) {
  const heading = ok ? "Google Workspace MCP" : "Google Workspace MCP — authorization failed"
  const body = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${heading}</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; color: #1a1a1a;">
<h2>${heading}</h2>
<p style="${ok ? "" : "color: #b3261e;"}">${message}</p>
</body>
</html>`
  return HttpServerResponse.text(body, { status: ok ? 200 : 400, contentType: "text/html" })
}
