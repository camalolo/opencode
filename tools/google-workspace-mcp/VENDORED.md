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
- `build/index.js` — matching input schemas/descriptions for the above.

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
