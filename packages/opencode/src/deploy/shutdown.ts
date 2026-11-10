export * as DeployShutdown from "./shutdown"

// Process-global latch the session loop polls at provider-call boundaries. The
// deploy drain raises it so long-running turns wrap up at the next safe point
// — after the current provider call and its tool executions settle — instead
// of waiting for the whole turn or killing tools mid-flight. Whatever is left
// unfinished is durable and gets re-driven after the restart.
//
// Deliberately plain mutable state: it is process memory by definition (the
// restart it coordinates kills the process), and a failed deploy clears it so
// normal looping resumes.

let latch = false

export const request = (): void => {
  latch = true
}

export const clear = (): void => {
  latch = false
}

export const requested = (): boolean => latch
