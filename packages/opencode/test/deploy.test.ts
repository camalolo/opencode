import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Fsp from "fs/promises"
import os from "os"
import path from "path"
import { Deploy } from "../src/deploy/deploy"
import { DeployResume } from "../src/deploy/resume"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { SessionStatus } from "../src/session/status"
import { SessionID } from "../src/session/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer } from "./fixture/fixture"
import { pollWithTimeout, testEffect } from "./lib/effect"

afterEach(async () => {
  await disposeAllInstances()
  await Fsp.rm(DeployResume.file(), { force: true })
})

const marker = path.join(os.tmpdir(), "opencode-deploy-test-marker")
const touchMarker = `echo restarted > "${marker}"`

const markerExists = Effect.gen(function* () {
  return yield* Effect.promise(() => Fsp.access(marker).then(() => true, () => false))
})

// pollWithTimeout resumes on any non-undefined value, so the predicate must be
// undefined while the marker is still absent.
const markerWaiting = Effect.gen(function* () {
  return (yield* markerExists) ? (true as const) : undefined
})

const resumeSessions = Effect.gen(function* () {
  const raw = yield* Effect.promise(() => Fsp.readFile(DeployResume.file(), "utf8"))
  return JSON.parse(raw).sessions as string[]
})

const resumeFileExists = Effect.gen(function* () {
  return yield* Effect.promise(() => Fsp.access(DeployResume.file()).then(() => true, () => false))
})

const deployLayer = (flags: Parameters<typeof RuntimeFlags.layer>[0]) =>
  Layer.mergeAll(
    LayerNode.compile(LayerNode.group([Deploy.node, SessionStatus.node]), [
      [RuntimeFlags.node, RuntimeFlags.layer(flags)],
    ]),
    testInstanceStoreLayer,
  )

const noopSteps = {
  deployPullCommand: "true",
  deployInstallCommand: "true",
  deployBuildCommand: "true",
  deployManifestCommand: "true",
}

const it = testEffect(
  Layer.mergeAll(
    deployLayer({ restartCommand: touchMarker, ...noopSteps }),
    testInstanceStoreLayer,
  ),
)

const itDisabled = testEffect(
  Layer.mergeAll(deployLayer(noopSteps), testInstanceStoreLayer),
)

const itFailingPull = testEffect(
  Layer.mergeAll(
    deployLayer({ restartCommand: touchMarker, ...noopSteps, deployPullCommand: "false" }),
    testInstanceStoreLayer,
  ),
)

// A restart command that hangs mimics the production restart (which kills the
// server mid-race): the deploy takes the killed-before-exit path and keeps the
// resume capture instead of discarding it as a failed restart.
const itSlowRestart = testEffect(
  Layer.mergeAll(
    deployLayer({ restartCommand: `echo restarted > "${marker}" && sleep 20`, ...noopSteps }),
    testInstanceStoreLayer,
  ),
)

const clearMarker = Effect.gen(function* () {
  yield* Effect.promise(() => Fsp.rm(marker, { force: true }))
})

describe("deploy", () => {
  it.live(
    "runs the steps and executes the restart command once idle",
    () =>
      Effect.gen(function* () {
        yield* provideInstance(os.tmpdir())(clearMarker)
        const svc = yield* Deploy.Service
        const started = yield* svc.start({ timeoutSeconds: 30 })
        expect(started.started).toBe(true)
        yield* pollWithTimeout(markerExists, "restart marker never appeared", "30 seconds")
        const error = yield* pollWithTimeout(
          Effect.gen(function* () {
            const s = yield* svc.status()
            return s.error
          }),
          "deploy never recorded the restart outcome",
          "20 seconds",
        )
        // the fake restart command exits without killing the test process,
        // which the deploy records as a failed restart
        expect(error).toContain("restart command exited with code 0")
        // nothing was mid-turn, so no resume capture was written
        expect(yield* resumeFileExists).toBe(false)
      }),
    60000,
  )

  itDisabled.live("refuses to start without a restart command", () =>
    Effect.gen(function* () {
      const svc = yield* Deploy.Service
      const started = yield* svc.start({ timeoutSeconds: 30 })
      expect(started.started).toBe(false)
      expect(started.reason).toContain("OPENCODE_RESTART_COMMAND")
    }),
  )

  it.live(
    "drains busy sessions before restarting",
    () =>
      Effect.gen(function* () {
        const svc = yield* Deploy.Service
        const statusSvc = yield* SessionStatus.Service
        yield* provideInstance(os.tmpdir())(
          Effect.gen(function* () {
            yield* clearMarker
            yield* statusSvc.set(SessionID.make("ses_test"), { type: "busy" })
          }),
        )
        const started = yield* svc.start({ timeoutSeconds: 60 })
        expect(started.started).toBe(true)
        yield* Effect.sleep("1 seconds")
        expect(yield* markerExists).toBe(false)
        yield* provideInstance(os.tmpdir())(
          statusSvc.set(SessionID.make("ses_test"), { type: "idle" }),
        )
        yield* pollWithTimeout(markerExists, "restart marker never appeared after idle", "30 seconds")
        // the session went idle before the restart, so nothing was captured
        expect(yield* resumeFileExists).toBe(false)
      }),
    60000,
  )

  itSlowRestart.live(
    "captures busy sessions for resume when the drain forces a restart",
    () =>
      Effect.gen(function* () {
        const svc = yield* Deploy.Service
        const statusSvc = yield* SessionStatus.Service
        yield* provideInstance(os.tmpdir())(
          Effect.gen(function* () {
            yield* clearMarker
            yield* statusSvc.set(SessionID.make("ses_deploy_resume"), { type: "busy" })
          }),
        )
        // a 1s drain deadline with a 2s poll interval forces the restart while
        // the session is still busy
        const started = yield* svc.start({ timeoutSeconds: 1 })
        expect(started.started).toBe(true)
        yield* pollWithTimeout(markerWaiting, "restart marker never appeared", "30 seconds")
        expect(yield* resumeSessions).toEqual(["ses_deploy_resume"])
        const status = yield* svc.status()
        expect(status.activeSessions).toEqual(["ses_deploy_resume"])
      }),
    60000,
  )

  itFailingPull.live(
    "aborts with an error when a step fails",
    () =>
      Effect.gen(function* () {
        yield* clearMarker
        const svc = yield* Deploy.Service
        const started = yield* svc.start({ timeoutSeconds: 30 })
        expect(started.started).toBe(true)
        yield* pollWithTimeout(
          Effect.gen(function* () {
            const status = yield* svc.status()
            return status.error !== undefined ? status.error : undefined
          }),
          "deploy never recorded the step failure",
          "10 seconds",
        )
        expect(yield* markerExists).toBe(false)
        const status = yield* svc.status()
        expect(status.phase).toBe("idle")
        expect(status.error).toContain("pull failed")
      }),
    30000,
  )
})
