import { AppProcess } from "@opencode-ai/core/process"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as Fsp from "fs/promises"
import os from "os"
import path from "path"
import { Deploy } from "../src/deploy/deploy"
import { RuntimeFlags } from "../src/effect/runtime-flags"
import { SessionStatus } from "../src/session/status"
import { SessionID } from "../src/session/schema"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer } from "./fixture/fixture"
import { pollWithTimeout, testEffect } from "./lib/effect"

afterEach(async () => {
  await disposeAllInstances()
})

const marker = path.join(os.tmpdir(), "opencode-deploy-test-marker")
const touchMarker = `echo restarted > "${marker}"`

const markerExists = Effect.gen(function* () {
  return yield* Effect.promise(() => Fsp.access(marker).then(() => true, () => false))
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

const clearMarker = Effect.gen(function* () {
  yield* Effect.promise(() => Fsp.rm(marker, { force: true }))
})

describe("deploy", () => {
  it.live("runs the steps and executes the restart command once idle", () =>
    Effect.gen(function* () {
      yield* provideInstance(os.tmpdir())(clearMarker)
      const svc = yield* Deploy.Service
      const started = yield* svc.start({ timeoutSeconds: 30 })
      expect(started.started).toBe(true)
      yield* pollWithTimeout(markerExists, "restart marker never appeared", "30 seconds")
      const status = yield* svc.status()
      expect(status.error).toBeUndefined()
    }),
  )

  itDisabled.live("refuses to start without a restart command", () =>
    Effect.gen(function* () {
      const svc = yield* Deploy.Service
      const started = yield* svc.start({ timeoutSeconds: 30 })
      expect(started.started).toBe(false)
      expect(started.reason).toContain("OPENCODE_RESTART_COMMAND")
    }),
  )

  it.live("drains busy sessions before restarting", () =>
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
    }),
  )

  itFailingPull.live("aborts with an error when a step fails", () =>
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
  )
})
