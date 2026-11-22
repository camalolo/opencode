import config from "../../playwright.config"

const port = Number(process.env.PLAYWRIGHT_PORT ?? 3000)
// Benchmarks run a production build, but never into the live `dist`: that
// directory is what the running server embeds, and a build there deletes the
// chunks its manifest still references. Build and preview from a scratch dir.
const outDir = "dist-perf"
process.env.PLAYWRIGHT_SERVER_PORT = String(port)
process.env.OPENCODE_PERFORMANCE_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`

export default {
  ...config,
  testDir: ".",
  testIgnore: "unit/**",
  outputDir: "../test-results/performance",
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: "../playwright-report/performance", open: "never" }], ["line"]],
  webServer: {
    ...config.webServer,
    command: `bun run build -- --outDir ${outDir} --emptyOutDir && bun run serve -- --outDir ${outDir} --host 0.0.0.0 --port ${port} --strictPort`,
    reuseExistingServer: false,
  },
}
