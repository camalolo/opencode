// Trigger a clean exit on a Bun inspector endpoint so --cpu-prof flushes.
// Usage: node cdp-exit.mjs ws://host:port/path
// Bun's --cpu-prof only writes the profile on clean process exit; the inspector
// has no Profiler domain, but Runtime.evaluate can call process.exit(0).
const ws = new WebSocket(process.argv[2])
ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "process.exit(0)" } }))
ws.onerror = (e) => {
  console.error("ws error:", e.type)
  process.exit(1)
}
setTimeout(() => process.exit(0), 4000)
