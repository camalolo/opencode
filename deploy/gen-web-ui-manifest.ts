// Regenerates packages/opencode/src/opencode-web-ui.gen.ts from packages/app/dist.
// Source-run servers import this manifest relative to packages/opencode/src
// (see the patch 05 import fallback in src/server/shared/ui.ts), so the
// specifiers must be ../../app/dist/... — one level deeper than the build-time
// virtual module in script/build.ts.
//
// Deploy step, run from the repo root after installing:
//   bun run --cwd packages/app build
//   bun deploy/gen-web-ui-manifest.ts
import path from "path"

const root = path.dirname(import.meta.dirname)
const dist = path.join(root, "packages/app/dist")
const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist, dot: true })))
  .map((file) => file.replaceAll("\\", "/"))
  .filter((file) => !file.endsWith(".map"))
  .sort()

const imports = files.map((file, i) => `import file_${i} from ${JSON.stringify(`../../app/dist/${file}`)} with { type: "file" };`)
const entries = files.map((file, i) => `  ${JSON.stringify(file)}: file_${i},`)
const out = [
  "// Generated: embedded web UI manifest (source-run equivalent of build-time gen)",
  "// Regenerate after rebuilding the web UI: bun deploy/gen-web-ui-manifest.ts",
  ...imports,
  "export default {",
  ...entries,
  "}",
  "",
].join("\n")

await Bun.write(path.join(root, "packages/opencode/src/opencode-web-ui.gen.ts"), out)
console.log(`manifest: ${files.length} files`)
