import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ChildProcess } from "effect/unstable/process"
import { Context, Effect, Layer } from "effect"
import * as path from "path"
import { existsSync } from "fs"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { SessionStatus } from "@/session/status"
import { EffectBridge } from "@/effect/bridge"

// Self-deploy: pull, build, drain in-flight sessions, then hand the process to
// the platform restart command. Intended for fleet servers that run from a
// source checkout (see AGENTS.md "Deploying").

const STABILITY_WINDOW_MS = 5_000
const POLL_INTERVAL_MS = 2_000
const STEP_TIMEOUT = "10 minutes"
const MAX_STEP_OUTPUT_BYTES = 4 * 1024 * 1024

export type Phase = "idle" | "pull" | "install" | "build" | "manifest" | "drain" | "restart"

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

    const runStep = Effect.fn("Deploy.step")(function* (phase: Phase, command: string) {
      state.phase = phase
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

    const drain = Effect.fn("Deploy.drain")(function* (timeoutSeconds: number) {
      state.phase = "drain"
      yield* Effect.logInfo("deploy drain", { timeoutSeconds })
      const deadline = Date.now() + timeoutSeconds * 1000
      let idleSince: number | undefined = undefined
      while (Date.now() < deadline) {
        const sessions = yield* statusSvc.listAll()
        const active = [...sessions.entries()].filter(([, info]) => info.type !== "idle").map(([id]) => id)
        state.activeSessions = active.length > 0 ? active : undefined
        if (active.length === 0) {
          if (idleSince === undefined) idleSince = Date.now()
          if (Date.now() - idleSince >= STABILITY_WINDOW_MS) return
        } else {
          idleSince = undefined
        }
        yield* Effect.sleep(POLL_INTERVAL_MS)
      }
      yield* Effect.logWarning("deploy drain timeout reached, forcing restart", {
        activeSessions: state.activeSessions,
      })
    })

    const runDeploy = Effect.fn("Deploy.run")(function* (timeoutSeconds: number) {
      const steps: Array<[Phase, string]> = [
        ["pull", flags.deployPullCommand || "git pull --ff-only origin laurent-dev"],
        ["install", flags.deployInstallCommand || "bun install"],
        ["build", flags.deployBuildCommand || "bun run --cwd packages/app build"],
        ["manifest", flags.deployManifestCommand || "bun deploy/gen-web-ui-manifest.ts"],
      ]
      for (const [phase, command] of steps) {
        const step = yield* runStep(phase, command)
        if (!step.ok) {
          state.error = step.error
          state.phase = "idle"
          return
        }
      }
      yield* drain(timeoutSeconds)
      state.phase = "restart"
      state.activeSessions = undefined
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
    })

    const start: Interface["start"] = Effect.fn("Deploy.start")(function* (input) {
      if (!flags.restartCommand) {
        return { started: false, reason: "OPENCODE_RESTART_COMMAND is not configured; refusing to deploy" }
      }
      if (!root) return { started: false, reason: "deploy requires a source checkout" }
      if (state.phase !== "idle") {
        return { started: false, reason: `deploy already running (phase: ${state.phase})` }
      }
      state.phase = "pull"
      state.startedAt = Date.now()
      state.error = undefined
      state.activeSessions = undefined
      yield* Effect.logInfo("deploy started", { timeoutSeconds: input.timeoutSeconds })
      bridge.fork(runDeploy(input.timeoutSeconds))
      return { started: true }
    })

    const status: Interface["status"] = Effect.fn("Deploy.status")(function* () {
      return { ...state }
    })

    return Service.of({ start, status })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [RuntimeFlags.node, SessionStatus.node, AppProcess.node],
})

export * as Deploy from "./deploy"
