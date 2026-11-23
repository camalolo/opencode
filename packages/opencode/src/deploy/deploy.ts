import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ChildProcess } from "effect/unstable/process"
import { Context, Effect, Layer } from "effect"
import * as path from "path"
import { existsSync } from "fs"
import { GlobalBus } from "@/bus/global"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionStatus } from "@/session/status"
import { EffectBridge } from "@/effect/bridge"
import { DeployResume } from "./resume"
import { DeployShutdown } from "./shutdown"

// Self-deploy: pull, build, then restart immediately. Intended for fleet
// servers that run from a source checkout (see AGENTS.md "Deploying").
//
// There is no drain: sessions mid-turn are interrupted by the restart,
// captured through DeployResume, resumed at the next boot, and each captured
// session gets a deploy notice so the resumed model re-checks its last
// operation instead of assuming it completed. Sleeping sessions stay parked
// on their durable triggers and are never woken by a deploy.
//
// DeployResume owns the boot side: a restarted server reports the "resume"
// deploy phase through the deploy status endpoint while the boot settle
// runs — API-visible only; the web UI reloads as soon as the rebooted
// server answers and session restore finishes in the background.

const STEP_TIMEOUT = "10 minutes"
const MAX_STEP_OUTPUT_BYTES = 4 * 1024 * 1024

/** Statuses that mean a provider turn or retry loop is in flight — these are
 * the sessions the restart interrupts and captures for resume. Sleeping
 * sessions are parked on a durable trigger and survive restarts untouched. */
const blocksDeploy = (info: SessionStatus.Info) => info.type === "busy" || info.type === "retry"

export type Phase = "idle" | "restore" | "pull" | "install" | "build" | "manifest" | "drain" | "restart"

export interface State {
  phase: Phase
  startedAt?: number
  error?: string
  activeSessions?: string[]
}

export interface StartResult {
  started: boolean
  reason?: string
}

export interface Interface {
  readonly start: (input: { timeoutSeconds: number }) => Effect.Effect<StartResult>
  readonly restore: () => Effect.Effect<StartResult>
  readonly status: () => Effect.Effect<State>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Deploy") {}

// Deploy only makes sense for source-run servers; derive the repo root from
// this module's location (.../packages/opencode/src/deploy).
function sourceRoot(): string | undefined {
  const root = path.resolve(import.meta.dir, "../../../..")
  if (!existsSync(path.join(root, "packages", "opencode", "package.json"))) return undefined
  return root
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const flags = yield* RuntimeFlags.Service
    const statusSvc = yield* SessionStatus.Service
    const appProcess = yield* AppProcess.Service
    const bridge = yield* EffectBridge.make()

    const root = sourceRoot()
    const state: State = { phase: "idle" as const }

    // Broadcast every state change on the global bus so connected web UIs can
    // show a deploy progress page instead of silently losing their event
    // stream when the restart lands.
    const announce = () => {
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: "server.deploy", properties: { ...state } },
      })
    }

    const runStep = Effect.fn("Deploy.step")(function* (phase: Phase, command: string) {
      state.phase = phase
      announce()
      yield* Effect.logInfo("deploy step", { phase, command })
      const shell = process.platform === "win32" ? "cmd" : "sh"
      const args = process.platform === "win32" ? ["/c", command] : ["-c", command]
      const result = yield* appProcess
        .run(
          ChildProcess.make(shell, args, { cwd: root ?? process.cwd(), extendEnv: true, stdout: "pipe", stderr: "pipe" }),
          { maxOutputBytes: MAX_STEP_OUTPUT_BYTES },
        )
        .pipe(
          Effect.timeout(STEP_TIMEOUT),
          Effect.catch((error) => Effect.succeed({ failed: true as const, detail: String(error) })),
        )
      if (result && "failed" in result) {
        yield* Effect.logError("deploy step failed", { phase, detail: result.detail })
        return { ok: false as const, error: `${phase} failed: ${result.detail}` }
      }
      if (result.exitCode !== 0) {
        const tail = Buffer.from(result.stderr).toString("utf8").slice(-2000)
        yield* Effect.logError("deploy step failed", { phase, exitCode: result.exitCode, stderr: tail })
        return { ok: false as const, error: `${phase} failed with exit code ${result.exitCode}: ${tail}` }
      }
      yield* Effect.logInfo("deploy step ok", { phase })
      return { ok: true as const }
    })

    const activeSessions = Effect.fn("Deploy.activeSessions")(function* () {
      const sessions = yield* statusSvc.listAll()
      return [...sessions.entries()].filter(([, info]) => blocksDeploy(info)).map(([id]) => id)
    })

    // Build steps shared by deploy and restore. Restore rewinds the checkout
    // one commit BEFORE anything is rebuilt, so a commit that broke the build
    // is rolled back first. The rewind discards the last pulled commit but
    // keeps history, so the next deploy pull fast-forwards back to the tip.
    // Vendored tools keep their own lockfile (not a workspace member), so the
    // root install never fetches their runtime deps.
    const buildSteps = (): Array<[Phase, string]> => [
      ["install", flags.deployInstallCommand || "bun install && bun install --cwd tools/google-workspace-mcp"],
      ["build", flags.deployBuildCommand || "bun run --cwd packages/app build"],
      ["manifest", flags.deployManifestCommand || "bun deploy/gen-web-ui-manifest.ts"],
    ]

    const restoreStep = (): [Phase, string] => [
      "restore",
      'git rev-parse -q --verify HEAD~1 >/dev/null || { echo "nothing to restore: HEAD~1 not found"; exit 1; }; git reset --hard HEAD~1',
    ]

    const runPipeline = Effect.fn("Deploy.run")(function* (steps: Array<[Phase, string]>) {
      for (const [phase, command] of steps) {
        const step = yield* runStep(phase, command)
        if (!step.ok) {
          state.error = step.error
          state.phase = "idle"
          announce()
          return
        }
      }
      state.phase = "restart"
      announce()
      // Last capture before the kill: these sessions are about to be
      // interrupted mid-turn; the next boot resumes them with a deploy notice.
      const interrupted = yield* activeSessions()
      state.activeSessions = interrupted.length > 0 ? interrupted : undefined
      yield* DeployResume.capture(interrupted)
      // "self-exit": the supervisor (systemd Restart=, NSSM AppExit Restart)
      // owns restarts; the deploy just terminates the process. This avoids the
      // Windows job-object race where an in-tree restart client is killed with
      // the service's process tree before it can issue the start.
      if (flags.restartCommand === "self-exit") {
        yield* Effect.logInfo("deploy restart: exiting for supervisor restart", { command: flags.restartCommand })
        setTimeout(() => process.exit(1), 500).unref()
        return
      }
      yield* Effect.logInfo("deploy restart", { command: flags.restartCommand })
      // The restart command kills this process, so it must outlive us: spawn it
      // detached and let the platform supervisor bring the server back.
      const shell = process.platform === "win32" ? "cmd" : "sh"
      const args = process.platform === "win32" ? ["/c", flags.restartCommand] : ["-c", flags.restartCommand]
      let child: Bun.Subprocess<"ignore", "pipe", "pipe">
      try {
        child = Bun.spawn([shell, ...args], {
          cwd: root ?? process.cwd(),
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        })
        child.unref()
      } catch (error) {
        yield* Effect.logError("deploy restart spawn failed", { error: String(error) })
        state.error = `restart command failed to spawn: ${String(error)}`
        state.phase = "idle"
        announce()
        DeployShutdown.clear()
        yield* DeployResume.discard()
        return
      }
      // Brief grace so status readers can observe the restart phase; the
      // process then dies when the restart command kills it. If the command
      // fails fast (bus errors, missing binary), surface its output instead of
      // pretending the restart happened.
      const outcome = yield* Effect.promise(async () => {
        const timer = new Promise<"killed-before-exit">((resolve) => setTimeout(() => resolve("killed-before-exit"), 15_000))
        const report = Promise.all([
          child.exited,
          new Response(child.stderr).text(),
          new Response(child.stdout).text(),
        ]).then(([code, stderr, stdout]) => ({ code, stderr: stderr.slice(-2000), stdout: stdout.slice(-2000) }))
        return Promise.race([timer, report])
      })
      if (outcome === "killed-before-exit") return
      yield* Effect.logError("deploy restart command exited without killing the server", outcome)
      state.error = `restart command exited with code ${outcome.code}: ${outcome.stderr || outcome.stdout}`
      state.phase = "idle"
      announce()
      DeployShutdown.clear()
      yield* DeployResume.discard()
    })

    const guard = (action: string): StartResult | undefined => {
      if (!flags.restartCommand) {
        return { started: false, reason: `OPENCODE_RESTART_COMMAND is not configured; refusing to ${action}` }
      }
      if (!root) return { started: false, reason: `${action} requires a source checkout` }
      if (state.phase !== "idle") {
        return { started: false, reason: `deploy or restore already running (phase: ${state.phase})` }
      }
      return undefined
    }

    const start: Interface["start"] = Effect.fn("Deploy.start")(function* (input) {
      const refused = guard("deploy")
      if (refused) return refused
      state.phase = "pull"
      state.startedAt = Date.now()
      state.error = undefined
      state.activeSessions = undefined
      announce()
      yield* Effect.logInfo("deploy started", { timeoutSeconds: input.timeoutSeconds })
      bridge.fork(runPipeline([["pull", flags.deployPullCommand || "git pull --ff-only origin laurent-dev"], ...buildSteps()]))
      return { started: true }
    })

    const restore: Interface["restore"] = Effect.fn("Deploy.restore")(function* () {
      const refused = guard("restore")
      if (refused) return refused
      state.phase = "restore"
      state.startedAt = Date.now()
      state.error = undefined
      state.activeSessions = undefined
      announce()
      yield* Effect.logInfo("restore started")
      bridge.fork(runPipeline([restoreStep(), ...buildSteps()]))
      return { started: true }
    })

    const status: Interface["status"] = Effect.fn("Deploy.status")(function* () {
      return { ...state }
    })

    return Service.of({ start, restore, status })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [RuntimeFlags.node, SessionStatus.node, AppProcess.node],
})

export * as Deploy from "./deploy"
