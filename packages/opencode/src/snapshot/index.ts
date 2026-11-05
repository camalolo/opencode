import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Duration, Effect, Layer, Schedule, Schema, Semaphore, Context } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { formatPatch, structuredPatch } from "diff"
import path from "path"
import { AppProcess } from "@opencode-ai/core/process"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Hash } from "@opencode-ai/core/util/hash"
import { Config } from "@/config/config"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Global } from "@opencode-ai/core/global"
import { Info } from "@opencode-ai/schema/file-diff"

export const Patch = Schema.Struct({
  hash: Schema.String,
  files: Schema.mutable(Schema.Array(Schema.String)),
})
export type Patch = typeof Patch.Type

export const FileDiff = Info
export type FileDiff = typeof FileDiff.Type

const prune = "7.days"
const limit = 2 * 1024 * 1024
// Last write-tree hash per shadow gitdir. Keyed by gitdir (not InstanceState) because
// instances in different subdirectories of one worktree share the same shadow repo;
// the write-tree result only depends on that shared index.
const lastTrees = new Map<string, string>()

// Watcher-fed pending-change set per shadow gitdir, shared like lastTrees.
// collect() asks: which files changed since the last full scan? An empty,
// quiet set lets track()/patch() skip the discovery scans entirely; a small
// non-empty set stages exactly those paths instead of rescanning the worktree.
interface Dirty {
  readonly files: Set<string>
  /** Subscription confirmed active; false until the promise resolves. */
  active: boolean
  /** Set on subscribe failure or a watcher error; drops trust until the next full scan. */
  failed: boolean
  /** Epoch ms of the last completed full scan (0 = untrusted). */
  lastScan: number
  /** Epoch ms of the last received watcher event. */
  lastEvent: number
  /** Epoch ms of the last completed add, any path. */
  lastAdd: number
  /** Instance states currently sharing this subscription. */
  refs: number
  /** Resolved subscription, released when refs drops to zero. */
  sub?: { unsubscribe: () => Promise<unknown> }
  /** Set when the last ref was released; a late-resolving subscribe then unsubscribes itself. */
  released?: boolean
}
const dirtyDirs = new Map<string, Dirty>()
// An empty set only counts as "no changes" after this much quiet: event
// delivery lags the write syscall by a few ms, so the tail of a fresh burst
// must not look like "nothing happened".
const QUIET_MS = 120
// When the last event or add is older than this, in-flight events are no
// longer plausible (production writes land a full provider round trip before
// the track that observes them), so the fast path trusts the pending set
// without waiting. Tests and fast steps stay inside the window and settle.
const FRESH_MS = 2_000
// A burst that never goes quiet falls back to a full scan, which is always
// correct; the cap bounds how long the fast path may wait for it.
const SETTLE_CAP = 1_000
// Beyond this many pending events a full scan is cheaper than staging a huge
// pathspec batch.
const DELTA_LIMIT = 512
// Bound how long event completeness is trusted without a full rescan, so
// silently missed events (inotify overflow, exotic filesystems) heal.
const RECONCILE_MS = 5 * 60_000

// Watcher subscriptions pin worktree directories for as long as they live
// (ReadDirectoryChangesW holds an open handle on Windows, which blocks
// delete/rename of the directory) and consume watch resources, so worktrees
// idle this long release their subscription; the next add() resubscribes and
// re-establishes trust with a full scan.
const dirIdleMs = () => Number(process.env.OPENCODE_SNAPSHOT_DIR_IDLE_MS) || 10 * 60_000

/** Releases watcher subscriptions of worktrees idle past the threshold. */
export const releaseIdleDirty = () => {
  const now = Date.now()
  for (const [gitdir, d] of dirtyDirs) {
    if (now - Math.max(d.lastEvent, d.lastAdd, d.lastScan) < dirIdleMs()) continue
    dirtyDirs.delete(gitdir)
    d.failed = true
    d.released = true
    d.sub?.unsubscribe().catch(() => {})
  }
}
let dirtySweeper: { unref?: () => void } | undefined
const ensureDirtySweeper = () => {
  if (dirtySweeper !== undefined) return
  const timer = setInterval(() => releaseIdleDirty(), 60_000) as unknown as { unref?: () => void }
  timer.unref?.()
  dirtySweeper = timer
}

// diffFull rows keyed by (path, before sha, after sha): the triple fully
// determines the diff text, and summarize recomputes the whole-turn diff at
// every step-finish while most per-file pairs repeat between consecutive steps.
const patchCache = new Map<string, FileDiff>()
const PATCH_CACHE_LIMIT = 4096
const zero = "0".repeat(40)
const isZero = (sha: string) => sha === zero
const cacheKey = (row: { file: string; before: string; after: string }) => `${row.file}\0${row.before}\0${row.after}`

interface AddResult {
  /** True when the shadow index was mutated (files staged or dropped). */
  readonly changed: boolean
}
const core = ["-c", "core.longpaths=true", "-c", "core.symlinks=true"]
const cfg = ["-c", "core.autocrlf=false", ...core]
const quote = [...cfg, "-c", "core.quotepath=false"]
interface GitResult {
  readonly code: ChildProcessSpawner.ExitCode
  readonly text: string
  readonly stderr: string
}

type State = Omit<Interface, "init">

export interface Interface {
  readonly init: () => Effect.Effect<void>
  readonly cleanup: () => Effect.Effect<void>
  readonly track: () => Effect.Effect<string | undefined>
  readonly patch: (hash: string, options?: { refresh?: boolean }) => Effect.Effect<Patch>
  readonly restore: (snapshot: string) => Effect.Effect<void>
  readonly revert: (patches: Patch[]) => Effect.Effect<void>
  readonly diff: (hash: string) => Effect.Effect<string>
  readonly diffFull: (from: string, to: string) => Effect.Effect<FileDiff[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Snapshot") {}

const layer: Layer.Layer<Service, never, FSUtil.Service | AppProcess.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const appProcess = yield* AppProcess.Service
    const config = yield* Config.Service
    const locks = new Map<string, Semaphore.Semaphore>()

    const lock = (key: string) => {
      const hit = locks.get(key)
      if (hit) return hit

      const next = Semaphore.makeUnsafe(1)
      locks.set(key, next)
      return next
    }

    const state = yield* InstanceState.make<State>(
      Effect.fn("Snapshot.state")(function* (ctx) {
        const state = {
          directory: ctx.directory,
          worktree: ctx.worktree,
          gitdir: path.join(Global.Path.data, "snapshot", ctx.project.id, Hash.fast(ctx.worktree)),
          vcs: ctx.project.vcs,
        }

        const args = (cmd: string[]) => ["--git-dir", state.gitdir, "--work-tree", state.worktree, ...cmd]

        const encodeNulTerminatedPaths = (files: string[]) => files.join("\0") + "\0"
        const encodeTopLevelLiteralPathspecs = (files: string[]) =>
          encodeNulTerminatedPaths(files.map((file) => `:(top,literal)${file}`))

        const git = Effect.fnUntraced(
          function* (cmd: string[], opts?: { cwd?: string; env?: Record<string, string>; stdin?: string }) {
            const result = yield* appProcess.run(
              ChildProcess.make("git", cmd, { cwd: opts?.cwd, env: opts?.env, extendEnv: true }),
              { stdin: opts?.stdin },
            )
            return {
              code: ChildProcessSpawner.ExitCode(result.exitCode),
              text: result.stdout.toString("utf8"),
              stderr: result.stderr.toString("utf8"),
            } satisfies GitResult
          },
          Effect.catch((err) =>
            Effect.succeed({
              code: ChildProcessSpawner.ExitCode(1),
              text: "",
              stderr: err instanceof Error ? err.message : String(err),
            }),
          ),
        )

        const ignore = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return new Set<string>()
          // check-ignore treats a leading colon as pathspec magic but accepts and echoes a protective ./ prefix.
          const checkIgnorePaths = files.map((item) => (item.startsWith(":") ? `./${item}` : item))
          const check = yield* git(
            [
              ...quote,
              "--git-dir",
              path.join(state.worktree, ".git"),
              "--work-tree",
              state.worktree,
              "check-ignore",
              "--no-index",
              "--stdin",
              "-z",
            ],
            {
              cwd: state.worktree,
              stdin: encodeNulTerminatedPaths(checkIgnorePaths),
            },
          )
          if (check.code !== 0 && check.code !== 1) return new Set<string>()
          return new Set(
            check.text
              .split("\0")
              .filter(Boolean)
              .map((item) => (item.startsWith("./:") ? item.slice(2) : item)),
          )
        })

        const drop = Effect.fnUntraced(function* (files: string[]) {
          if (!files.length) return
          yield* git(
            [
              ...cfg,
              ...args(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]),
            ],
            {
              cwd: state.worktree,
              stdin: encodeTopLevelLiteralPathspecs(files),
            },
          )
        })

        const stage = Effect.fnUntraced(function* (files: string[]) {
          let remaining = files
          const seen = new Set<string>()
          while (remaining.length) {
            const result = yield* git(
              [...cfg, ...args(["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"])],
              {
                cwd: state.worktree,
                stdin: encodeTopLevelLiteralPathspecs(remaining),
              },
            )
            if (result.code === 0) return
            // One un-addable path (e.g. a Windows reserved device name like NUL)
            // fails the whole batch; retry without the offenders instead of losing
            // every other change. Git reports them worktree-relative and quoted.
            const skipped = new Set(
              [...result.stderr.matchAll(/error: (?:invalid path|unable to add) '(.+?)'/gm)]
                .map((match) => path.join(state.worktree, match[1]!).replaceAll("\\", "/"))
                .filter((item) => !seen.has(item)),
            )
            if (!skipped.size) {
              yield* Effect.logWarning("failed to add snapshot files", {
                exitCode: result.code,
                stderr: result.stderr,
              })
              return
            }
            for (const item of skipped) seen.add(item)
            yield* Effect.logWarning("skipping files git cannot add to the snapshot", { files: [...skipped] })
            remaining = remaining.filter((item) => !seen.has(item.replaceAll("\\", "/")))
          }
        })

        const exists = (file: string) => fs.exists(file).pipe(Effect.orDie)
        const read = (file: string) => fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")))
        const remove = (file: string) => fs.remove(file).pipe(Effect.catch(() => Effect.void))
        const locked = <A, E, R>(fx: Effect.Effect<A, E, R>) => lock(state.gitdir).withPermits(1)(fx)

        const enabled = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return false
          return (yield* config.get()).snapshot !== false
        })

        const excludes = Effect.fnUntraced(function* () {
          const result = yield* git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], {
            cwd: state.worktree,
          })
          const file = result.text.trim()
          if (!file) return
          if (!(yield* exists(file))) return
          return file
        })

        const sync = Effect.fnUntraced(function* (list: string[] = []) {
          const file = yield* excludes()
          const target = path.join(state.gitdir, "info", "exclude")
          const text = [
            file ? (yield* read(file)).trimEnd() : "",
            ...list.map((item) => `/${item.replaceAll("\\", "/")}`),
          ]
              .filter(Boolean)
              .join("\n")
          const next = text ? `${text}\n` : ""
          // Rewriting this file on every track churns the filesystem for no gain
          // (measurable on Windows where every write can trigger AV re-scans).
          if ((yield* read(target)) === next) return
          yield* fs.ensureDir(path.join(state.gitdir, "info")).pipe(Effect.orDie)
          yield* fs.writeFileString(target, next).pipe(Effect.orDie)
        })

        // Reuse the hashes for the git storage between the original repo and snapshot
        // on huge repos like chromium checkout the git add --all rebuilding the
        // hashes can take minutes. By doing this we eliminating this at all
        const seed = Effect.fnUntraced(function* () {
          if (state.vcs !== "git") return

          const commonDir = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"], {
            cwd: state.worktree,
          })

          if (commonDir.code !== 0) return
          const source = commonDir.text.trim()
          if (!source || !(yield* exists(source))) return

          // Share the source object database (and the source's own alternates,
          // skipping any that no longer exist) so seeded blobs resolve.
          const sourceObjects = path.join(source, "objects")
          const chained = (yield* read(path.join(sourceObjects, "info", "alternates")))
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
          const alternates: string[] = []
          for (const candidate of [sourceObjects, ...chained]) {
            if (yield* exists(candidate)) alternates.push(candidate)
          }
          if (!alternates.length) return

          yield* fs.ensureDir(path.join(state.gitdir, "objects", "info")).pipe(Effect.orDie)
          yield* fs
            .writeFileString(path.join(state.gitdir, "objects", "info", "alternates"), alternates.join("\n") + "\n")
            .pipe(Effect.orDie)

          // Seed the index from the source repo so already-hashed entries are reused.
          // Best-effort: a missing/incompatible index just falls back to a full add.
          const sourceIndex = path.join(source, "index")
          if (yield* exists(sourceIndex)) {
            yield* fs.copyFile(sourceIndex, path.join(state.gitdir, "index")).pipe(Effect.catch(() => Effect.void))
          }
        })

        // Get (or create) the shared dirty state for this worktree and start its
        // filesystem subscription on first use. The subscription ignores only
        // .git so its coverage is a superset of anything snapshotting could
        // stage; gitignore filtering stays at use time via ignore().
        const dirty = () => {
          const hit = dirtyDirs.get(state.gitdir)
          if (hit) {
            if (!acquired) {
              acquired = true
              hit.refs += 1
            }
            return hit
          }
          const next: Dirty = {
            files: new Set(),
            active: false,
            failed: false,
            lastScan: 0,
            lastEvent: 0,
            lastAdd: 0,
            refs: 1,
          }
          acquired = true
          dirtyDirs.set(state.gitdir, next)
          ensureDirtySweeper()
          if (state.vcs !== "git" || Flag.OPENCODE_DISABLE_SNAPSHOT_WATCHER) {
            next.failed = true
            return next
          }
          const pending = Watcher.subscribeRaw(state.worktree, [".git", "**/.git", "**/.git/**"], (error, events) => {
            if (error) {
              next.failed = true
              return
            }
            next.lastEvent = Date.now()
            for (const event of events) {
              const rel = path.relative(state.worktree, event.path).replaceAll("\\", "/")
              if (rel.startsWith("..")) continue
              next.files.add(rel)
            }
          })
          if (!pending) {
            next.failed = true
            return next
          }
          pending.then(
            (sub) => {
              if (next.released) {
                sub.unsubscribe().catch(() => {})
                return
              }
              next.sub = sub
              next.active = true
            },
            () => {
              next.failed = true
            },
          )
          return next
        }

        // Hold the shared subscription for this instance's lifetime and release
        // it when the last instance of the worktree goes away, so visited
        // worktrees do not leak watcher resources.
        let acquired = false
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            const d = dirtyDirs.get(state.gitdir)
            if (!d) return
            d.refs -= 1
            if (d.refs > 0) return
            dirtyDirs.delete(state.gitdir)
            d.failed = true
            d.released = true
            d.sub?.unsubscribe().catch(() => {})
          }),
        )

        // Only root instances use the dirty fast paths: full scans are scoped
        // to the instance directory, so subdirectory instances keep rescanning.
        const scoped = state.directory !== state.worktree
        // undefined -> run a full discovery scan; [] -> skip everything;
        // paths -> stage exactly those files.
        const delta = (d: Dirty) => {
          if (scoped || !d.active || d.failed) return undefined
          if (Date.now() - d.lastScan >= RECONCILE_MS) return undefined
          if (d.files.size === 0) return Date.now() - Math.max(d.lastScan, d.lastEvent) > QUIET_MS ? [] : undefined
          if (d.files.size > DELTA_LIMIT) return undefined
          return [...d.files]
        }

        const deltaAdd = Effect.fnUntraced(function* (d: Dirty, files: string[]) {
          // Stage exactly the evented paths instead of rescanning the worktree.
          // Mirrors the full scan's decisions for these files: ignore
          // resolution, the untracked 2MB cap, and dropping entries that turned
          // ignored. Returns undefined to fall back to a full scan.
          const classified = yield* git(
            [...quote, ...args(["ls-files", "-z", "--", ...files.map((file) => `:(top,literal)${file}`)])],
            { cwd: state.worktree },
          )
          if (classified.code !== 0) return undefined
          const tracked = new Set(classified.text.split("\0").filter(Boolean))

          const stats = yield* Effect.all(
            files.map((file) =>
              fs.stat(path.join(state.worktree, file)).pipe(Effect.catch(() => Effect.succeed(undefined))),
            ),
            { concurrency: 8 },
          )
          const statOf = new Map(files.map((file, i) => [file, stats[i]]))
          // A new directory means its contents were created before the watcher
          // started observing it — their events are invisible, so only a full
          // scan can capture them (the directory's own create event always
          // arrives via the parent's watch, so this stays airtight).
          if (files.some((file) => statOf.get(file)?.type === "Directory")) return undefined
          // Vanished untracked paths stage nothing themselves; a pathspec
          // matching nothing fails the whole staging batch.
          const candidates = files.filter((file) => tracked.has(file) || statOf.get(file) !== undefined)

          const scannedAt = Date.now()
          d.files.clear()
          if (!candidates.length) {
            d.lastScan = scannedAt
            return { changed: false }
          }

          const ignored = yield* ignore(candidates)
          let changed = false
          const unstage = [...ignored].filter((file) => tracked.has(file))
          if (unstage.length) {
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: unstage.length })
            yield* drop(unstage)
            changed = true
          }
          const allow = candidates.filter((file) => !ignored.has(file))
          if (allow.length) {
            const large = new Set(
              allow.filter((file) => {
                if (tracked.has(file)) return false
                const stat = statOf.get(file)
                if (!stat || stat.type !== "File") return false
                const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                return size > limit
              }),
            )
            if (large.size) yield* sync([...large])
            const stageFiles = allow.filter((file) => !large.has(file))
            if (stageFiles.length) {
              yield* stage(stageFiles)
              changed = true
            }
          }
          // The index moved without a matching write-tree, so any cached tree is
          // now stale.
          if (changed) lastTrees.delete(state.gitdir)
          d.lastScan = scannedAt
          return { changed }
        })

        const add = Effect.fnUntraced(function* () {
          const d = dirty()
          const result = yield* addInner(d)
          d.lastAdd = Date.now()
          return result
        })

        const addInner = Effect.fnUntraced(function* (d: Dirty) {
          let candidates = delta(d)
          if (candidates !== undefined && Date.now() - Math.max(d.lastEvent, d.lastAdd) < FRESH_MS) {
            // Fresh activity: event batches may still be in flight (the watcher
            // delivers bursts in multiple rounds). Wait until the stream goes
            // quiet, then take the pending set as complete; a burst that never
            // settles falls back to a full scan, which is always correct.
            const started = Date.now()
            do {
              yield* Effect.sleep(10)
              if (Date.now() - started > SETTLE_CAP) {
                candidates = undefined
                break
              }
            } while (Date.now() - d.lastEvent < QUIET_MS)
            if (candidates !== undefined) candidates = [...d.files]
          }
          // Quiet and empty: skip the exclude sync, ignore resolution, stats,
          // and staging entirely.
          if (candidates && !candidates.length) return { changed: false }

          yield* sync()
          if (candidates) {
            // Stage the pending set, folding in stragglers that land mid-staging
            // (event batches can trail a burst). Only a fully drained delta may
            // return; anything else falls through to a full scan.
            let result: AddResult | undefined
            let drained = false
            for (let round = 0; round < 3; round++) {
              result = yield* deltaAdd(d, candidates)
              if (!result) break
              drained = d.files.size === 0
              if (drained) break
              candidates = [...d.files]
            }
            if (result && drained) return result
          }

          // Full discovery scan. Clearing the pending set up front keeps events
          // that arrive while the scan runs pending for the next one.
          d.files.clear()
          const scannedAt = Date.now()
          const [diff, other] = yield* Effect.all(
            [
              git([...quote, ...args(["diff-files", "--name-only", "-z", "--", "."])], {
                cwd: state.directory,
              }),
              git([...quote, ...args(["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", "."])], {
                cwd: state.directory,
              }),
            ],
            { concurrency: 2 },
          )
          if (diff.code !== 0 || other.code !== 0) {
            d.lastScan = 0
            yield* Effect.logWarning("failed to list snapshot files", {
              diffCode: diff.code,
              diffStderr: diff.stderr,
              otherCode: other.code,
              otherStderr: other.stderr,
            })
            return { changed: false }
          }

          const tracked = diff.text.split("\0").filter(Boolean)
          const untracked = other.text.split("\0").filter(Boolean)
          const all = Array.from(new Set([...tracked, ...untracked]))
          // Nothing changed since the last scan: skip ignore resolution,
          // stats, and staging entirely.
          if (!all.length) {
            d.lastScan = scannedAt
            return { changed: false }
          }

          // Resolve source-repo ignore rules against the exact candidate set.
          // --no-index keeps this pattern-based even when a path is already tracked.
          const ignored = yield* ignore(all)
          let changed = false

          // Remove newly-ignored files from snapshot index to prevent re-adding
          if (ignored.size > 0) {
            const ignoredFiles = Array.from(ignored)
            yield* Effect.logInfo("removing gitignored files from snapshot", { count: ignoredFiles.length })
            yield* drop(ignoredFiles)
            changed = true
          }

          const allow = all.filter((item) => !ignored.has(item))
          if (!allow.length) {
            // The index moved without a matching write-tree, so any cached tree
            // is now stale.
            if (changed) lastTrees.delete(state.gitdir)
            d.lastScan = scannedAt
            return { changed }
          }

          // The 2MB cap only blocks untracked files, so only those need a stat.
          const large = new Set(
            (yield* Effect.all(
              untracked.map((item) =>
                fs
                  .stat(path.join(state.worktree, item))
                  .pipe(Effect.catch(() => Effect.void))
                  .pipe(
                    Effect.map((stat) => {
                      if (!stat || stat.type !== "File") return
                      const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
                      return size > limit ? item : undefined
                    }),
                  ),
              ),
              { concurrency: 8 },
            )).filter((item): item is string => Boolean(item)),
          )
          const block = new Set(untracked.filter((item) => large.has(item)))
          yield* sync(Array.from(block))
          // Stage only the allowed candidate paths so snapshot updates stay scoped.
          const stageFiles = allow.filter((item) => !block.has(item))
          if (stageFiles.length) {
            yield* stage(stageFiles)
            changed = true
          }
          // The index moved without a matching write-tree, so any cached tree is
          // now stale.
          if (changed) lastTrees.delete(state.gitdir)
          d.lastScan = scannedAt
          return { changed }
        })

        const cleanup = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              if (!(yield* exists(state.gitdir))) return
              // --auto only repacks when enough loose objects accumulated, so the
              // hourly tick is a cheap no-op most of the time instead of a full gc.
              const result = yield* git(args(["gc", "--auto", `--prune=${prune}`]), { cwd: state.directory })
              if (result.code !== 0) {
                yield* Effect.logWarning("cleanup failed", {
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              yield* Effect.logInfo("cleanup", { prune })
            }),
          )
        })

        const track = Effect.fnUntraced(function* () {
          return yield* locked(
            Effect.gen(function* () {
              if (!(yield* enabled())) return
              const existed = yield* exists(state.gitdir)
              yield* fs.ensureDir(state.gitdir).pipe(Effect.orDie)
              if (!existed) {
                yield* git(["init"], {
                  env: { GIT_DIR: state.gitdir, GIT_WORK_TREE: state.worktree },
                })
                // Write the shadow-repo tuning in one file write; eight sequential
                // `git config` spawns cost ~25ms each on Windows.
                const config = [
                  "[core]",
                  "\tautocrlf = false",
                  "\tlongpaths = true",
                  "\tsymlinks = true",
                  "\tfsmonitor = false",
                  "\tuntrackedCache = true",
                  "[index]",
                  "\tversion = 4",
                  "\tthreads = true",
                  "[feature]",
                  "\tmanyFiles = true",
                  "",
                ].join("\n")
                const configPath = path.join(state.gitdir, "config")
                yield* fs.writeFileString(configPath, (yield* read(configPath)) + config).pipe(Effect.orDie)
                yield* seed()
                yield* Effect.logInfo("initialized")
              }
              const result = yield* add()
              // Nothing changed since the last scan and we already know the tree:
              // skip the write-tree, which re-reads the full index.
              const cached = lastTrees.get(state.gitdir)
              if (!result.changed && cached) {
                yield* Effect.logInfo("tracking", { hash: cached, cwd: state.directory, git: state.gitdir })
                return cached
              }
              const tree = yield* git(args(["write-tree"]), { cwd: state.directory })
              const hash = tree.text.trim()
              if (hash) lastTrees.set(state.gitdir, hash)
              yield* Effect.logInfo("tracking", { hash, cwd: state.directory, git: state.gitdir })
              return hash
            }),
          )
        })

        const patch = Effect.fnUntraced(function* (hash: string, options?: { refresh?: boolean }) {
          return yield* locked(
            Effect.gen(function* () {
              // Callers that tracked immediately before already have a fresh index;
              // refreshing again re-runs the full worktree scan for nothing.
              if (options?.refresh !== false) yield* add()
              const result = yield* git(
                [...quote, ...args(["diff", "--cached", "--no-ext-diff", "--name-only", hash, "--", "."])],
                {
                  cwd: state.directory,
                },
              )
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", { hash, exitCode: result.code })
                return { hash, files: [] }
              }
              const files = result.text
                .trim()
                .split("\n")
                .map((x) => x.trim())
                .filter(Boolean)

              // Hide ignored-file removals from the user-facing patch output.
              const ignored = yield* ignore(files)

              return {
                hash,
                files: files
                  .filter((item) => !ignored.has(item))
                  .map((x) => path.join(state.worktree, x).replaceAll("\\", "/")),
              }
            }),
          )
        })

        const restore = Effect.fnUntraced(function* (snapshot: string) {
          return yield* locked(
            Effect.gen(function* () {
              // read-tree replaces the shadow index behind the cache's back, so the
              // cached tree no longer describes it.
              lastTrees.delete(state.gitdir)
              // Files created after the snapshot reappear as untracked for the
              // next full scan; an empty pending set must not hide them.
              const d = dirtyDirs.get(state.gitdir)
              if (d) d.lastScan = 0
              yield* Effect.logInfo("restore", { commit: snapshot })
              // Only rewrite files whose worktree content drifted from the snapshot.
              // `checkout-index -a -f` rewrites every tracked file in the worktree,
              // which costs seconds on large checkouts. The drift set is computed
              // BEFORE read-tree (which zeroes index stat data): staged drift via a
              // tree-to-tree diff, worktree drift via the porcelain diff (plumbing
              // diff-files is stat-based and would list touch-only files). Paths
              // absent from the snapshot (D status) must be excluded:
              // checkout-index cannot write them and would fail the batch.
              let files: string[] | undefined
              const currentTree = yield* git(args(["write-tree"]), { cwd: state.worktree })
              if (currentTree.code === 0 && currentTree.text.trim()) {
                const [staged, worktree] = yield* Effect.all(
                  [
                    git(
                      [
                        ...quote,
                        ...args(["diff", "--no-ext-diff", "--no-renames", "--name-status", "-z", currentTree.text.trim(), snapshot, "--", "."]),
                      ],
                      { cwd: state.worktree },
                    ),
                    git(
                      [
                        "--no-optional-locks",
                        ...quote,
                        ...args(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", "--", "."]),
                      ],
                      { cwd: state.worktree },
                    ),
                  ],
                  { concurrency: 2 },
                )
                if (staged.code === 0 && worktree.code === 0) {
                  const gone = new Set<string>()
                  const changed: string[] = []
                  const parts = staged.text.split("\0")
                  for (let i = 0; i + 1 < parts.length; ) {
                    const code = parts[i++]!
                    const file = parts[i++]!
                    if (code.startsWith("D")) gone.add(file)
                    else changed.push(file)
                  }
                  files = [
                    ...new Set([
                      ...changed,
                      ...worktree.text.split("\0").filter((file) => file && !gone.has(file)),
                    ]),
                  ]
                }
              }
              const result = yield* git([...core, ...args(["read-tree", snapshot])], { cwd: state.worktree })
              if (result.code !== 0) {
                yield* Effect.logError("failed to restore snapshot", {
                  snapshot,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return
              }
              if (!files) {
                // Drift listing failed; fall back to rewriting everything.
                const checkout = yield* git([...core, ...args(["checkout-index", "-a", "-f"])], {
                  cwd: state.worktree,
                })
                if (checkout.code === 0) return
                yield* Effect.logError("failed to restore snapshot", {
                  snapshot,
                  exitCode: checkout.code,
                  stderr: checkout.stderr,
                })
                return
              }
              if (!files.length) return
              const checkout = yield* git([...core, ...args(["checkout-index", "-f", "-z", "--stdin"])], {
                cwd: state.worktree,
                stdin: encodeNulTerminatedPaths(files),
              })
              if (checkout.code === 0) return
              yield* Effect.logError("failed to restore snapshot", {
                snapshot,
                exitCode: checkout.code,
                stderr: checkout.stderr,
              })
            }),
          )
        })

        const revert = Effect.fnUntraced(function* (patches: Patch[]) {
          return yield* locked(
            Effect.gen(function* () {
              // `git checkout <tree> -- <file>` below updates the shadow index, so
              // the cached tree no longer describes it.
              lastTrees.delete(state.gitdir)
              const d = dirtyDirs.get(state.gitdir)
              if (d) d.lastScan = 0
              const ops: { hash: string; file: string; rel: string }[] = []
              const seen = new Set<string>()
              for (const item of patches) {
                for (const file of item.files) {
                  if (seen.has(file)) continue
                  seen.add(file)
                  ops.push({
                    hash: item.hash,
                    file,
                    rel: path.relative(state.worktree, file).replaceAll("\\", "/"),
                  })
                }
              }

              const single = Effect.fnUntraced(function* (op: (typeof ops)[number]) {
                yield* Effect.logInfo("reverting", { file: op.file, hash: op.hash })
                const result = yield* git([...core, ...args(["checkout", op.hash, "--", op.file])], {
                  cwd: state.worktree,
                })
                if (result.code === 0) return
                const tree = yield* git([...core, ...args(["ls-tree", op.hash, "--", op.rel])], {
                  cwd: state.worktree,
                })
                if (tree.code === 0 && tree.text.trim()) {
                  yield* Effect.logInfo("file existed in snapshot but checkout failed, keeping", {
                    file: op.file,
                    hash: op.hash,
                  })
                  return
                }
                yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                yield* remove(op.file)
              })

              const clash = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)

              for (let i = 0; i < ops.length; ) {
                const first = ops[i]!
                const run = [first]
                let j = i + 1
                // Only batch adjacent files when their paths cannot affect each other.
                while (j < ops.length && run.length < 100) {
                  const next = ops[j]!
                  if (next.hash !== first.hash) break
                  if (run.some((item) => clash(item.rel, next.rel))) break
                  run.push(next)
                  j += 1
                }

                if (run.length === 1) {
                  yield* single(first)
                  i = j
                  continue
                }

                const tree = yield* git(
                  [...core, ...args(["ls-tree", "--name-only", first.hash, "--", ...run.map((item) => item.rel)])],
                  {
                    cwd: state.worktree,
                  },
                )

                if (tree.code !== 0) {
                  yield* Effect.logInfo("batched ls-tree failed, falling back to single-file revert", {
                    hash: first.hash,
                    files: run.length,
                  })
                  for (const op of run) {
                    yield* single(op)
                  }
                  i = j
                  continue
                }

                const have = new Set(
                  tree.text
                    .trim()
                    .split("\n")
                    .map((item) => item.trim())
                    .filter(Boolean),
                )
                const list = run.filter((item) => have.has(item.rel))
                if (list.length) {
                  yield* Effect.logInfo("reverting", { hash: first.hash, files: list.length })
                  const result = yield* git(
                    [...core, ...args(["checkout", first.hash, "--", ...list.map((item) => item.file)])],
                    {
                      cwd: state.worktree,
                    },
                  )
                  if (result.code !== 0) {
                    yield* Effect.logInfo("batched checkout failed, falling back to single-file revert", {
                      hash: first.hash,
                      files: list.length,
                    })
                    for (const op of run) {
                      yield* single(op)
                    }
                    i = j
                    continue
                  }
                }

                for (const op of run) {
                  if (have.has(op.rel)) continue
                  yield* Effect.logInfo("file did not exist in snapshot, deleting", { file: op.file, hash: op.hash })
                  yield* remove(op.file)
                }

                i = j
              }
            }),
          )
        })

        const diff = Effect.fnUntraced(function* (hash: string) {
          return yield* locked(
            Effect.gen(function* () {
              yield* add()
              const result = yield* git([...quote, ...args(["diff", "--cached", "--no-ext-diff", hash, "--", "."])], {
                cwd: state.worktree,
              })
              if (result.code !== 0) {
                yield* Effect.logWarning("failed to get diff", {
                  hash,
                  exitCode: result.code,
                  stderr: result.stderr,
                })
                return ""
              }
              return result.text.trim()
            }),
          )
        })

        const diffFull = Effect.fnUntraced(function* (from: string, to: string) {
          // Identical trees diff to nothing; steps whose tools wrote nothing must
          // not spawn a single git process for this.
          if (from === to) return []

          type Row = {
            file: string
            status: "added" | "deleted" | "modified"
            binary: boolean
            additions: number
            deletions: number
            before: string
            after: string
          }

          // Tree-to-tree reads and object loads never touch the shadow index, so
          // this needs no gitdir lock: summarize runs it from a forked fiber
          // while the next step's track() holds the lock.
          {
          // Load blob contents by sha in one cat-file --batch round trip,
          // deduplicated across rows.
          const blobs = Effect.fnUntraced(
            function* (shas: string[]) {
              const batch = yield* appProcess.run(
                ChildProcess.make("git", [...cfg, ...args(["cat-file", "--batch"])], {
                  cwd: state.directory,
                  extendEnv: true,
                }),
                { stdin: shas.join("\n") + "\n" },
              )
              if (batch.exitCode !== 0) {
                yield* Effect.logInfo(
                  "git cat-file --batch failed during snapshot diff, falling back to per-file git show",
                  { stderr: batch.stderr.toString("utf8"), shas: shas.length },
                )
                return
              }
              const out = batch.stdout
              const map = new Map<string, string>()
              const dec = new TextDecoder()
              let i = 0
              for (const sha of shas) {
                let end = i
                while (end < out.length && out[end] !== 10) end += 1
                if (end >= out.length) return
                const head = dec.decode(out.slice(i, end))
                i = end + 1
                if (head.endsWith(" missing")) continue
                const match = head.match(/^[0-9a-f]+ blob (\d+)$/)
                if (!match) return
                const size = Number(match[1])
                if (!Number.isInteger(size) || size < 0 || i + size >= out.length || out[i + size] !== 10) return
                map.set(sha, dec.decode(out.slice(i, i + size)))
                i += size + 1
              }
              if (i !== out.length) return
              return map
            },
            Effect.scoped,
            Effect.catch(() => Effect.succeed<Map<string, string> | undefined>(undefined)),
          )

          const show = Effect.fnUntraced(function* (row: Row) {
            if (row.binary) return ["", ""]
            if (row.status === "added") {
              return ["", yield* git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text))]
            }
            if (row.status === "deleted") {
              return [
                yield* git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                "",
              ]
            }
            return yield* Effect.all(
              [
                git([...cfg, ...args(["show", `${from}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
                git([...cfg, ...args(["show", `${to}:${row.file}`])]).pipe(Effect.map((item) => item.text)),
              ],
              { concurrency: 2 },
            )
          })

          // ":<oldmode> <newmode> <oldsha> <newsha> <status>\0<path>\0" per entry;
          // an all-zero sha marks the side as absent (added/deleted).
          const raw = yield* git(
            [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--raw", "-z", from, to, "--", "."])],
            { cwd: state.directory },
          )
          if (raw.code !== 0) {
            yield* Effect.logWarning("failed to get diff", { from, to, exitCode: raw.code, stderr: raw.stderr })
            return []
          }
          const rows: Row[] = []
          const parts = raw.text.split("\0")
          for (let i = 0; i + 1 < parts.length; i += 2) {
            const hit = parts[i]!.match(/^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/)
            if (!hit) continue
            rows.push({
              file: parts[i + 1]!,
              status: hit[3] === "A" ? "added" : hit[3] === "D" ? "deleted" : "modified",
              // Pessimistic until numstat proves otherwise: a row numstat never
              // reports would otherwise run the text differ over binary content.
              binary: true,
              additions: 0,
              deletions: 0,
              before: hit[1]!,
              after: hit[2]!,
            })
          }

          const numstat = yield* git(
            [...quote, ...args(["diff", "--no-ext-diff", "--no-renames", "--numstat", "-z", from, to, "--", "."])],
            { cwd: state.directory },
          )
          if (numstat.code === 0) {
            const byFile = new Map(rows.map((row) => [row.file, row]))
            for (const entry of numstat.text.split("\0")) {
              if (!entry) continue
              const first = entry.indexOf("\t")
              const second = entry.indexOf("\t", first + 1)
              if (first < 0 || second < 0) continue
              const row = byFile.get(entry.slice(second + 1))
              if (!row) continue
              const adds = entry.slice(0, first)
              const dels = entry.slice(first + 1, second)
              row.binary = adds === "-" && dels === "-"
              if (!row.binary) {
                row.additions = parseInt(adds) || 0
                row.deletions = parseInt(dels) || 0
              }
            }
          }

          // Hide ignored-file removals from the user-facing diff output.
          const ignored = yield* ignore(rows.map((row) => row.file))
          const visible = ignored.size > 0 ? rows.filter((row) => !ignored.has(row.file)) : rows

          const result: FileDiff[] = []
          const step = 100
          const patch = (file: string, before: string, after: string) =>
            formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))

          for (let i = 0; i < visible.length; i += step) {
            const run = visible.slice(i, i + step)
            // (path, before sha, after sha) fully determines a row's diff text.
            // summarize recomputes the whole-turn diff at every step-finish and
            // most per-file pairs repeat between consecutive steps, so misses
            // only pay for genuinely new content.
            const misses = run.filter((row) => !patchCache.has(cacheKey(row)))
            const needed = new Set(
              misses.flatMap((row) => (row.binary ? [] : [row.before, row.after])).filter((sha) => !isZero(sha)),
            )
            const loaded = needed.size ? yield* blobs([...needed]) : undefined

            for (const row of run) {
              const key = cacheKey(row)
              const hit = patchCache.get(key)
              if (hit) {
                result.push(hit)
                continue
              }
              let before = ""
              let after = ""
              if (!row.binary) {
                if (loaded) {
                  before = row.before === zero ? "" : (loaded.get(row.before) ?? "")
                  after = row.after === zero ? "" : (loaded.get(row.after) ?? "")
                } else {
                  ;[before, after] = yield* show(row)
                }
              }
              const diff: FileDiff = {
                file: row.file,
                patch: row.binary ? "" : patch(row.file, before, after),
                additions: row.additions,
                deletions: row.deletions,
                status: row.status,
              }
              patchCache.set(key, diff)
              if (patchCache.size > PATCH_CACHE_LIMIT) patchCache.delete(patchCache.keys().next().value!)
              result.push(diff)
            }
          }

          return result
          }
        })

        yield* cleanup().pipe(
          Effect.catchCause((cause) => Effect.logError("cleanup loop failed", { cause: Cause.pretty(cause) })),
          Effect.repeat(Schedule.spaced(Duration.hours(1))),
          Effect.delay(Duration.minutes(1)),
          Effect.forkScoped,
        )

        return { cleanup, track, patch, restore, revert, diff, diffFull }
      }),
    )

    return Service.of({
      init: Effect.fn("Snapshot.init")(function* () {
        yield* InstanceState.get(state)
      }),
      cleanup: Effect.fn("Snapshot.cleanup")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.cleanup())
      }),
      track: Effect.fn("Snapshot.track")(function* () {
        return yield* InstanceState.useEffect(state, (s) => s.track())
      }),
      patch: Effect.fn("Snapshot.patch")(function* (hash: string, options?: { refresh?: boolean }) {
        return yield* InstanceState.useEffect(state, (s) => s.patch(hash, options))
      }),
      restore: Effect.fn("Snapshot.restore")(function* (snapshot: string) {
        return yield* InstanceState.useEffect(state, (s) => s.restore(snapshot))
      }),
      revert: Effect.fn("Snapshot.revert")(function* (patches: Patch[]) {
        return yield* InstanceState.useEffect(state, (s) => s.revert(patches))
      }),
      diff: Effect.fn("Snapshot.diff")(function* (hash: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diff(hash))
      }),
      diffFull: Effect.fn("Snapshot.diffFull")(function* (from: string, to: string) {
        return yield* InstanceState.useEffect(state, (s) => s.diffFull(from, to))
      }),
    })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, AppProcess.node, Config.node],
})

export * as Snapshot from "."
