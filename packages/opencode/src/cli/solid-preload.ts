// Registers @opentui/solid's JSX transform Bun plugin before any TSX module loads.
// bun compiles TSX with React semantics (static eager children) unless this plugin
// is installed, which breaks Solid context flow (providers mount after consumers).
// Package bunfig.toml files preload this for `bun test`/cwd launches, but the CLI
// can start from any directory, so registration must not depend on bunfig discovery.
import { ensureSolidTransformPlugin } from "@opentui/solid/bun-plugin"

ensureSolidTransformPlugin()
