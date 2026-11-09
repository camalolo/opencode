- To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly.
- Keep runtime dependencies directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` composes Client, Core, and Server.
- The default branch in this repo is `dev`.
- Local `main` ref may not exist; use `dev` or `origin/dev` for diffs.

## Branch Names

Use a short branch name of at most three words, separated by hyphens. Do not use slashes or type prefixes such as `feat/` or `fix/`.

Examples: `session-recovery`, `fix-scroll-state`, `regenerate-sdk`.

## Commits and PR Titles

Use conventional commit-style messages and PR titles: `type(scope): summary`.

Valid types are `feat`, `fix`, `docs`, `chore`, `refactor`, and `test`. Scopes are optional; use the affected package or area when helpful, e.g. `core`, `opencode`, `tui`, `app`, `desktop`, `sdk`, or `plugin`.

Examples: `fix(tui): simplify thinking toggle styling`, `docs: update contributing guide`, `chore(sdk): regenerate types`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.

## Server Fleet

Three servers run this fork, all tracking `laurent-dev`:

| Host | Server URL | Service control | Notes |
|------|------------|-----------------|-------|
| `home` (this machine, cubi-n200) | http://127.0.0.1:4096 | `systemctl --user restart opencode` | dev box AND production; the user's real sessions run here and phone access goes through `https://home.opencode.camalolo.com`. Repo: `~/Sources/opencode`. A restart kills active sessions, so check the idle rule first even for dev work. Restarting this server from the bash tool kills the tool session's own server: the call returns interrupted mid-output even though the restart succeeds — treat the interruption as expected and verify via `/global/health` + a fresh `boot` id instead of re-running |
| `m2dev-laurent` (ssh alias) | http://127.0.0.1:4096 (via ssh) | `systemctl --user restart opencode` | Magento production/dev box (`app2.m2.shop.lomography.com`, 142.132.174.83). SAME HOST as `m2app2` (`ssh -J home laurent@m2app2`; the bare `m2app2` alias defaults to user `carlsen`, which has no opencode access). Real user sessions (Stripe/Magento work) run here — treat as production, check the idle rule. |
| `desktop` (ssh alias, Windows, `LAURENT-DESKTOP`) | http://localhost:4096 (via ssh; `https://desktop.opencode.camalolo.com` from outside) | `pwsh -NoProfile -File C:/Users/camal/scripts/restart-services.ps1` (self-elevates) | Production user sessions; NOT a dev box since 2026-11-04 (development moved to home), but still runs the fork from the repo. Repo: `C:\Program Files\Opencode` (moved there 2026-11-05 from `D:\Development\External`, before that `E:\Development\External`). The repo dir is ACL-granted to user `laurent` (the Windows account; `camal` is only the profile folder name), so git/bun/build run unprivileged there — but ANY repo move dangles bun's absolute-path junctions in `node_modules`; after a move, delete `node_modules` and run a fresh `bun install` (moving into Program Files needs one elevated step). Server started by `C:\Users\camal\scripts\opencode-server-patched.ps1`; `bun run --conditions=browser "C:/Program Files/Opencode/packages/opencode/src/index.ts" serve --hostname 0.0.0.0 --port 4096`. ssh lands in cmd.exe, not pwsh (inline pwsh one-liners lose `$_` through the ssh→cmd→pwsh chain — scp a .ps1 script file and run it with `-File` instead). `git pull` over ssh fails because the Win32 ssh client hangs when its stdio is pipes in sshd-spawned sessions (auth + banner flow, exec/data never delivers — same against any server; the GitHub key in desktop's ssh-agent service is fine and `-n` doesn't help; interactive pulls and `cmd /c ssh ... > file` work). Deploy non-interactively via `git bundle` + scp, or interactive pull. The snapshot watcher (ReadDirectoryChangesW) holds open handles on tracked worktree dirs while they are active, briefly blocking delete/rename; handles release automatically after ~10 min idle (configurable via `OPENCODE_SNAPSHOT_DIR_IDLE_MS`) or on restart. Historical Windows infra notes: `HANDOVER.md` (repo root, untracked on purpose — never commit or push it). |

### Fleet customizations (outside this repo)

These live on the servers, not in git. They survive `git pull`/rebuilds — a future agent must not assume stock behavior.

- **Server runtime (home)**: repo TS runs directly via bun through a systemd drop-in (`~/.config/systemd/user/opencode.service.d/patched.conf` overrides `ExecStart` to `bun run --conditions=browser ~/Sources/opencode/packages/opencode/src/index.ts serve ...`). `OPENCODE_DISABLE_CHANNEL_DB=1` there is load-bearing (channel DB selection for source builds); other drop-ins hold the RunPod API key and `SSH_AUTH_SOCK`. Server-code rollback = `git revert` + restart, no rebuild (UI needs build + manifest, see Deploying).
- **OTLP trace collector (home)**: `opencode-otlp.service` receives the server's spans (env `OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318` in the drop-in) and appends them to `~/.local/share/opencode/log/traces.jsonl`. That file is the data source for opencode profiling work (collector: `tools/profiling/otlp-collector.mjs`) — keep the service running; it costs ~38 MB RAM and ~0.03% CPU. traces.jsonl grows unbounded (~10 KB/h); delete it freely when you don't need old spans.
- **Browser stack (all servers)**: built into opencode (`packages/opencode/src/browser/` — `daemon.ts` transport+supervisor, `agent.ts` daemon actions, `tools.ts` the 25 `browser_*` core tools). No npm plugin, no systemd service/timer, no scheduled task. The `agent-browser` 0.37.1 binary is an npm dep of packages/opencode; the supervisor spawns it lazily as a detached per-server daemon pinned by `OPENCODE_BROWSER_AGENT_SESSION` (kept at `opencode-default` in every server's launcher env — one shared browser per server). Facts that keep biting:
  - Socket placement mirrors the daemon's own rule: `<AGENT_BROWSER_SOCKET_DIR or XDG_RUNTIME_DIR>/agent-browser/<session>.sock` (daemon refuses to start with neither set; on Windows it's TCP 127.0.0.1:<49152 + hash(session) % 16384>). `OPENCODE_BROWSER_AGENT_SOCKET` overrides the path — remove it from launcher env, the client derives the path itself now.
  - Daemon survives opencode restarts (browser state persists across deploys; the daemon restores tabs from its `.target` file). Supervisor handles the rest in-process: 6h age-based graceful recycle via the daemon's `close` action, orphan-chromium sweep rooted at ALL live daemon pidfiles (not just our session — killing "orphans" without checking foreign daemons takes down the shared browser), tab hoard/stale sweep (KEEP_MAX 8, stale >1h), and `agent-browser install` before cold spawns (provisions the matching browser into `~/.agent-browser/browsers`; skip via `OPENCODE_BROWSER_AGENT_SKIP_INSTALL=1`; skipped in `daemon.ts` on win32 — the Windows exe daemonizes when spawned without a TTY, so a server-side install can only stall until the 600s kill timer. On Windows provision manually into `~/.agent-browser/browsers/chrome-<ver>/chrome-win64/` (nested layout, CfT win64 zip; daemon prefers that cache over system Chrome) — done once on desktop 2026-11-07 with 157.0.8103.38; version bumps need a fresh download + a matching MinimalFirewall allow rule, Windows firewall program paths can't wildcard).
  - Raw-CDP rules (baked into `browser_cdp` output): re-attach fresh every time (port + UUIDs change on recycle), never send an `Origin` header (Chromium 403).
  - The old external-plugin patches (console/errors over agent backend, `browser_cdp`, `browser_query` page_text newline fix) live in `agent.ts`/`tools.ts` now; claims are a real in-process registry instead of throwing on the agent backend. `browser_screenshot` reads the daemon's file output — daemon 0.37.x never returned base64, so the old plugin's screenshot silently always failed.
- **OCR**: vendored patched `opencode-parser` at `~/.config/opencode/vendor/opencode-parser` + shim `~/.config/opencode/plugins/parser.ts` (all servers). Bun+Arborist installs npm-specifier plugins hollow — never add `opencode-parser` to the plugin array; keep the shim. Patch: image attachments for text-only models are saved to a temp file with a `parse` instruction instead of being sent as data URLs.
- **Providers**: `camalolo.com` is the user's llm-proxy (source: home `~/Sources/llm-proxy`, Express+TS). Custom-proxy providers don't inherit models.dev metadata by model ID — declare `attachment`/`modalities` per model or images get stripped. Phone/remote access: `https://home.opencode.camalolo.com` (nginx TLS on home).
- **nginx on home**: opencode vhosts (`home.`/`m2app2.`/`desktop.opencode.camalolo.com`; `desktop.` proxies to the Windows box) have an anti-port-scan guard `if ($server_addr != "192.168.1.16") { return 444; }` — curl tests must use `--resolve <host>:443:192.168.1.16` or they get instant 000/PROTOCOL_ERROR even on the box itself. Asset caching lives in `/etc/nginx/conf.d/00-opencode-asset-cache.conf`: `/assets/*` responses get `Cache-Control: immutable, max-age=31536000` **only for 2xx/304** (status-scoped map, fixed 2026-11-04 after an incident; backup at `*.bak-statusfix`). NEVER let error responses carry that header — a cached 404 for a chunk URL bricks the client's SPA for a year.
- **Never build the UI into a server's dist outside the deploy chain**: `bun run --cwd packages/app build` empties `packages/app/dist`, deleting the chunk files live SPAs are lazily importing mid-session. Incident 2026-11-03: a session built the UI on home with the wrong channel flavor (`OPENCODE_CHANNEL` difference changes vite hashes), the phone's live SPA got 404s for its chunks (new-session page crashed, session-delete died silently — the click never issued a request), and nginx's always-on immutable header cached the 404s client-side. The running server serves `index.html`/assets via the embedded ui manifest from the last `gen-web-ui-manifest.ts` + restart, but chunk imports resolve per-request — dist must stay hash-consistent with the manifest era.

### Deploying

UI changes need build + manifest regen + restart on EVERY server (restarting alone keeps serving the old UI). Repos: `~/Sources/opencode` on the Linux boxes, `C:\Program Files\Opencode` on desktop.

Each server can deploy itself: `POST /global/deploy` runs pull → `bun install` → web UI build → manifest regen, waits for in-flight sessions to go idle (drain, `?timeout=<seconds>`, default 600), then runs the configured restart command. The request returns immediately; the triggering turn finishes naturally and the server restarts when the fleet is quiet. `GET /global/deploy` reports the phase (`idle|pull|install|build|manifest|drain|restart`) and any error.

```sh
# home (this machine, run locally; respects the idle rule by draining)
curl -X POST "http://127.0.0.1:4096/global/deploy?timeout=600"

# m2dev-laurent
ssh m2dev-laurent 'curl -X POST "http://127.0.0.1:4096/global/deploy?timeout=600"'

# desktop (Windows; ssh lands in cmd.exe)
ssh desktop "curl -X POST \"http://127.0.0.1:4096/global/deploy?timeout=600\""
```

Fallback (deploy command unavailable / first bootstrapping of this feature):

```sh
# home
cd ~/Sources/opencode && git pull --ff-only origin laurent-dev && bun install && bun run --cwd packages/app build && bun deploy/gen-web-ui-manifest.ts && systemctl --user restart opencode

# m2dev-laurent (also needs /home/laurent/.nvm/versions/node/v24.8.0/bin first in PATH)
ssh m2dev-laurent 'export PATH=$HOME/.bun/bin:$PATH; cd ~/Sources/opencode && git pull --ff-only origin laurent-dev && bun install && bun run --cwd packages/app build && bun deploy/gen-web-ui-manifest.ts && systemctl --user restart opencode'

# desktop (interactive git pull only, or git bundle + scp; then restart)
ssh desktop "cd /d \"C:\Program Files\Opencode\" && git pull --ff-only origin laurent-dev && bun install && bun run --cwd packages/app build && bun deploy/gen-web-ui-manifest.ts"
ssh desktop "pwsh -NoProfile -File C:/Users/camal/scripts/restart-services.ps1"
```

Self-deploy config (env, per server — do NOT rely on `/global/deploy` without these):

| env | home / m2dev value | desktop value |
|-----|--------------------|---------------|
| `OPENCODE_RESTART_COMMAND` (required; deploys refuse without it) — the systemd drop-in line must QUOTE the value (`Environment="OPENCODE_RESTART_COMMAND=..."`), otherwise systemd splits on spaces and the command runs argument-less | `systemctl --user restart opencode` | `powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\camal\scripts\restart-services.ps1` |
| `OPENCODE_DEPLOY_PULL_COMMAND` (optional) | default `git pull --ff-only origin laurent-dev` | default; desktop's Task Scheduler context pulls over Win32 ssh fine (the hanging-ssh workaround is only needed for sshd-spawned sessions) |
| `OPENCODE_DEPLOY_INSTALL_COMMAND` / `OPENCODE_DEPLOY_BUILD_COMMAND` / `OPENCODE_DEPLOY_MANIFEST_COMMAND` (optional) | defaults | defaults |

Desktop gotcha: the `opencode-server` Task Scheduler task only tracks its direct process — `schtasks /end` does NOT kill the bun server (the launcher's port-busy guard then makes `/run` a no-op). Always restart via `restart-services.ps1`, which kills by command line and restarts the task.

On m2dev, `m2dev-laurent` additionally needs `/home/laurent/.nvm/versions/node/v24.8.0/bin` first in PATH for manual builds.

### Idle rule (mandatory)

A restart kills active sessions. `POST /global/deploy` drains on its own (waits for in-flight turns to finish before restarting), so the grep below is only needed when using the manual fallback chain or a bare restart. Before pulling/restarting any server (home included — it is production), verify it is idle (run the grep locally on home, via ssh on m2dev; on desktop the same log lives at `C:\Users\camal\.local\share\opencode\log\opencode.log` — grep it via `findstr` through cmd or a pwsh one-liner):

```sh
ssh <host> 'grep -a "message=stream\|message=loop" ~/.local/share/opencode/log/opencode.log | tail -1'
```

Compare the entry's `timestamp=` (UTC) against `date -u`: require >= 300s of quiet. If sessions are active, ask the user first; never generate test turns on home.

### Verify after deploy

- Health: `curl -s http://127.0.0.1:4096/global/health` -> 200.
- New process: `curl -sN -m 3 http://127.0.0.1:4096/global/event | sed -n 2p` -> `server.connected` prelude carries a fresh `boot` id.
- `git log --oneline -1` matches the `laurent-dev` tip.
- Pushes need `git push --no-verify origin laurent-dev` (pre-push bun-version gate fails otherwise).

### Local testing

- Sessions must live in directory `~/.agent-browser` to appear in the UI (registered project; sessions in other dirs don't show in the sidebar).
- Session-scoped API calls need `?directory=` or the `x-opencode-directory` header.

### Deferred deploy (busy server)

When a remote is active but the change must land, stage a watcher on the remote instead of retrying manually: it polls the log every 60s and runs the full deploy chain itself at the first >= 300s quiet window (cap it with a deadline, e.g. 4h, so it cannot fire on a stale window a day later).

1. Write the script (idle check + deploy chain + deadline) to `/tmp/<name>.sh` on the remote via ssh.
2. Launch detached: `ssh <host> 'setsid nohup bash /tmp/<name>.sh >/tmp/<name>.log 2>&1 < /dev/null &'`.
3. Check progress: `ssh <host> 'cat /tmp/<name>.log; pgrep -f "<name>"'`. It exits after firing once.

Gotchas:
- `pkill -f <name>` from an ssh command line self-matches the ssh command itself and kills the session - use the bracket trick (`pkill -f "name-with-[i]dle"`) or target the exact script path.
- A busy swarm can hold the log hot for hours; if the user says go, interrupting is acceptable - the running turn dies but session state survives the restart. Confirm with the user before interrupting.

### Fleet lessons (2026-11-06, learned the hard way)

- **Heavy local builds are covered by the idle rule too.** `bun turbo typecheck` (which `packages/opencode`'s typecheck script runs) spawns a tsgo process per workspace package; on home that army + live sessions + the xmrswapper stack swap-thrashed the N200 into a manual reboot. Scope typechecks to changed packages (`bunx tsgo --noEmit` in the package dir), and don't run `bun install`/test sweeps that rewrite `node_modules` under the live server — lazy imports then load half-swapped native modules.
- **The `pkill`/`pgrep -f` self-match applies to LOCAL bash tool calls, not just ssh.** The tool call's own wrapper process contains the pattern, so an unbracketed `pkill -f "<name>"` kills the chain mid-flight — later steps silently never run (a "completed" restart that didn't happen). Always bracket (`"name-with-[i]dle"`), and never trust a health check as proof of restart: verify via `systemctl --user show opencode.service -p ExecMainStartTimestamp` or a fresh boot id.
- **On desktop, `bun.exe` is both the server and the TUI — never `Stop-Process bun` without matching the command line.** Filter for `attach` (TUI probes/orphans) vs `serve` (production server); a parent-chain-only filter killed the production server once (2026-11-06). Same care for `Get-Process bun | Stop-Process` in repair scripts.
- **`setsid` changes session, not cgroup.** Deferred watchers launched from a bash tool session die when `opencode.service` restarts (systemd kills the whole service cgroup). In deploy scripts that end with a service restart, write durable state (markers, logs) BEFORE the restart line — the script's own epilogue will not run.
- **Server-only deploys on desktop need no UAC** (found 2026-11-07): `schtasks /end /tn opencode-server` + `schtasks /run /tn opencode-server` works from a non-elevated ssh session. Two gotchas: the 4096 LISTEN socket lingers ~35s after `/end` (poll for the port to free before `/run` or the launcher exits on its port-busy guard), and killing the server's process tree takes the detached agent-browser daemon AND its chrome down with it (they stay children of the server on Windows) — the daemon cold-spawns on the next browser call, which (post-2026-11-07) launches the provisioned CfT chrome under the `MFW - agent-browser-chrome` firewall rule.
- **Desktop Defender exclusions are path-bound and drift on repo moves.** The old `D:\Development` exclusion doesn't cover `C:\Program Files\Opencode`; unexcluded node_modules makes bun install crawl under real-time scanning. Keep `C:\Program Files\Opencode`, `C:\Users\camal\.bun`, `C:\Users\camal\.opencode` (plugin install dir), and `C:\Users\camal\.local\share\opencode` in `Get-MpPreference` ExclusionPath, plus the `bun.exe` process exclusion. Also: Windows `timeout` is a pause utility, not coreutils — for bounded runs use PowerShell `Start-Process` + `Sleep` + `Stop-Process`.
- **Source-run TUI needs the @opentui/solid JSX transform; bun only installs it via cwd bunfig.** Bun's default TSX transform uses React semantics (static eager children evaluated bottom-up), which mounts a Solid tree consumer-first — context providers execute *after* the components they wrap, so the TUI crashed with "…Provider is missing" (blank screen). `packages/tui` and `packages/opencode` bunfig.toml fix this with `preload = ["@opentui/solid/preload"]`, but bun reads bunfig **from the launch cwd** — the fleet launches from `~` / `C:\Users\camal`, so the TUI was blank on every server while "working" when launched from inside those package dirs (a treacherous repro). Fix: `packages/opencode/src/cli/solid-preload.ts` calls `ensureSolidTransformPlugin()` and is imported first in `index.ts`, making registration cwd-independent. Per-file `@jsxImportSource` pragmas only switch the import source, not the children strategy — they do NOT fix this. `--tsconfig-override` changes resolution but not the JSX transform — also does NOT fix this.
