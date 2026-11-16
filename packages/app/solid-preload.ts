import { plugin } from "bun"

// bun test has no Solid JSX transform: its default TSX loader emits React-shaped
// jsx/jsxDEV calls, which solid-js does not export, so any test importing a .tsx
// chain fails at import. Compile .tsx with babel-preset-solid — the same
// transform the vite build uses — targeting the DOM client runtime. Workspace
// packages (@opencode-ai/*) resolve through node_modules symlinks, so only the
// isolated store (.bun) is excluded, not node_modules wholesale. bun's test
// runner still default-compiles externals ahead of plugins, so chains crossing
// into workspace packages must import them dynamically.
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /^(?!.*[/\\]node_modules[/\\]\.bun[/\\]).*\.tsx$/ }, async (args) => {
      const { transformAsync } = await import("@babel/core")
      const { default: solidPreset } = await import("babel-preset-solid")
      const { default: tsPreset } = await import("@babel/preset-typescript")
      const source = await Bun.file(args.path).text()
      const result = await transformAsync(source, {
        filename: args.path,
        configFile: false,
        babelrc: false,
        presets: [
          [solidPreset, { moduleName: "solid-js/web", generate: "dom" }],
          [tsPreset, {}],
        ],
      })
      return { contents: result?.code ?? source, loader: "js" }
    })
  },
})
