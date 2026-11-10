import type { SessionStatus } from "@opencode-ai/sdk/v2"

// A session is only working while the provider round trip is live (busy) or a
// retry backoff is running. A sleeping session has an armed sleep_until trigger
// but no active work: its last turn is finished, so turn-finished UI (assistant
// meta line, changed-files summary) must render even though the status is not
// idle — the titlebar/sidebar carry the sleeping indicator instead. This mirrors
// the server's `session_working` (busy || retry) semantics.
export function sessionWorking(status: SessionStatus["type"] | undefined) {
  return status === "busy" || status === "retry"
}
