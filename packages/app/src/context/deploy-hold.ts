// Servers whose deploy (including the post-restart boot resume) is mid-flight.
// While a server is held, the server-sdk event stream must not reload the page
// on a boot change: the deploy overlay owns the reload, which happens when the
// deploy status reports its final idle. Keyed by ServerConnection.key.
const held = new Set<string>()

export const deployHold = {
  mark: (key: string) => held.add(key),
  release: (key: string) => held.delete(key),
  isHeld: (key: string) => held.has(key),
}
