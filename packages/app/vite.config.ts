import { sentryVitePlugin } from "@sentry/vite-plugin"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"
import { defineConfig, type Plugin } from "vite"
import desktopPlugin from "./vite"

// `deploy/gen-web-ui-manifest.ts` embeds the file list from `packages/app/dist`
// into `packages/opencode/src/opencode-web-ui.gen.ts`; the server falls back to
// proxying the upstream UI when that manifest does not match disk. Keep the pair
// consistent by regenerating the manifest after any build that writes the live
// dist, and fail the build when the regen fails.
function webUiManifestPlugin(): Plugin {
  const root = import.meta.dirname
  const liveDist = resolve(root, "dist")
  let outDir = liveDist
  return {
    name: "opencode-web-ui-manifest",
    apply: "build",
    configResolved(config) {
      outDir = resolve(root, config.build.outDir)
    },
    closeBundle() {
      if (outDir !== liveDist) return
      const result = spawnSync("bun", ["deploy/gen-web-ui-manifest.ts"], {
        cwd: resolve(root, "../.."),
        stdio: "inherit",
      })
      if (result.error) throw new Error(`web UI manifest regen failed to spawn: ${result.error.message}`)
      if (result.status !== 0) throw new Error(`web UI manifest regen failed (exit ${result.status})`)
    },
  }
}


const sentry =
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT
    ? sentryVitePlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        telemetry: false,
        release: {
          name: process.env.SENTRY_RELEASE ?? process.env.VITE_SENTRY_RELEASE,
        },
        sourcemaps: {
          assets: "./dist/**",
          filesToDeleteAfterUpload: "./dist/**/*.map",
        },
      })
    : false

export default defineConfig({
  plugins: [desktopPlugin, webUiManifestPlugin(), sentry] as any,
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    port: 3000,
  },
  build: {
    target: "esnext",
    sourcemap: true,
  },
})
