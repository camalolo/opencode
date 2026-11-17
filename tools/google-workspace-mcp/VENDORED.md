# Vendored: @alanxchen/google-workspace-mcp

Vendored copy of `@alanxchen/google-workspace-mcp@2.0.1` (npm, MIT, author alanx),
customized for this fork. The upstream npm package ships no repository URL and only
compiled `build/` output, so **`build/` is the source of truth here** — edit the JS
directly.

Why vendored: we previously ran it via `npx -y @alanxchen/google-workspace-mcp`, which
kept our local patches in `~/.npm/_npx/...` — invisible to git and wiped by npx cache
eviction or any upstream version bump. This copy is tracked and deploys with the repo.

## Local patches (vs upstream 2.0.1)

- `build/tools/gmail.js` — "pricefix" body extraction (2026-11-10, pre-existing local
  patch carried over): `read_email` walks the full MIME tree (nested multipart parts)
  with charset-aware decoding, prefers `text/plain`, falls back to a stripped
  `text/html` rendering instead of only looking at top-level parts.
- `build/tools/gmail.js` — draft replies (2026-11-11):
  - `reply_to_email` gained `draft?: boolean` — builds the reply (In-Reply-To /
    References / `Re:` subject) but stores it as a Gmail draft in the original thread
    via `drafts.create` instead of sending. The References chain now also carries the
    parent's own `References` header, not just its Message-ID.
  - `create_draft` gained `in_reply_to?` (Gmail message ID: derives thread ID +
    In-Reply-To + References from the parent), `thread_id?`, `references?`.
  - Fixed stock bug: both draft paths used `.filter(Boolean)` on the header array,
    which swallowed the blank line separating RFC822 headers from the body — the body
    got glued onto the last header line and Gmail silently discarded it.
- `build/tools/gmail.js` — image extraction (2026-11-14):
  - New `extract_email_images` tool: walks the MIME tree for `image/*` parts
    (inline `cid:` images and attached images alike), fetches large parts via
    `attachments.get` when only an `attachmentId` is present, and writes them to
    disk (optional `directory` arg, default `<tmpdir>/email-images/<messageId>`).
    Filenames come from the part, the Content-ID, or `image-N.<ext>`; collisions
    get `-N` suffixes. Returns local paths so the agent can open the files with
    normal file tools (show_image, parse, ...).
  - `embed` option (default true): the result carries a private `_embed_images`
    key `[{mimeType, data(base64)}]` which the `call_tool` handler converts to
    MCP `image` content blocks — multimodal clients (opencode `session/tools.ts`)
    turn those into tool-result attachments, and `message-v2.ts` puts them in the
    model context exactly like chat-uploaded images (inline for Anthropic/OpenAI/
    Gemini-3, synthetic user message elsewhere; text-only models get an explicit
    "does not support image input" text instead). svg and images over 3.5 MB
    (keeps base64 under Anthropic's 5 MB per-image limit) stay disk-only, flagged
    `embedded: false`.
  - `read_email` now returns an `attachments` array (filename, mimeType, size,
    attachmentId, inline flag) so the model can see images exist before extracting.
- `build/index.js` — matching input schemas/descriptions for the above; the
  `call_tool` handler strips `_embed_images` from the JSON text block and
  re-emits it as MCP image content blocks.
- `build/auth.js` — link-based re-auth (2026-11-17, supersedes the interactive
  flows as the `auto` default): when the refresh token is expired/revoked and
  `GOOGLE_WORKSPACE_MCP_PUBLIC_URL` (or `<authDir>/public-url`) is configured,
  a failed tool call returns fast with a Google consent link instead of
  hanging in browser auth (which waits 5 min on a `localhost:4100` callback
  no remote browser will ever hit; on Windows services there is no usable
  display either). The consent link redirects to
  `<public base>/oauth/google/callback` — a route in the opencode server —
  which writes the authorization code to `<authDir>/auth-code.json`; the next
  MCP call exchanges it and proceeds. Handles the multi-process race where
  several opencode-spawned MCP children compete for the single-use code (the
  losers re-read token.json, which the winner refreshed). Exchange uses
  `prompt=consent`, so the grant yields a durable refresh token — device-flow
  grants carry `refresh_token_expires_in ≈ 28h` and die daily; device flow is
  also rejected outright for desktop-type OAuth clients (`invalid_client`).
  Set `GOOGLE_WORKSPACE_MCP_AUTH_FLOW=browser` to use the old on-box browser
  flow; `auto` falls back to it (then device flow) only when no public URL is
  configured. The auth dir defaults to `~/.google-workspace-mcp` and is
  overridable with `GOOGLE_WORKSPACE_MCP_AUTH_DIR`.

## Wiring

`~/.config/opencode/opencode.json` → `mcp["google-workspace"]` runs
`node <repo>/tools/google-workspace-mcp/build/index.js` (stdio). OAuth credentials
live outside the repo at `~/.google-workspace-mcp/{credentials.json,token.json}`
(same location the npx version used — no auth migration needed).

## Maintenance

Deps are pinned in `package.json`; `bun install` inside this directory creates a
self-contained `node_modules` (not a repo workspace member, so it never touches the
root lockfile). Check upstream occasionally (`npm view @alanxchen/google-workspace-mcp
version`); to take an upstream change, re-copy `build/` and re-apply the patches above.
