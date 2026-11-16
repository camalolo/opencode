import { describe, expect, test } from "bun:test"
import { projectForSession } from "./helpers"
import type { Session } from "@opencode-ai/sdk/v2/client"

// Imports only pure-TypeScript modules: helpers.ts pulls the tsx-heavy server
// and layout contexts as type-only imports, so this file avoids the Solid JSX
// transform that bun test does not register in this package.

const session = (input: { id: string; directory: string; projectID: string }): Session => ({
  id: input.id,
  slug: input.id,
  projectID: input.projectID,
  directory: input.directory,
  title: "test",
  version: "v2",
  time: { created: 0, updated: 0 },
})

const project = (id: string, worktree: string, sandboxes: string[] = []) => ({ id, worktree, sandboxes })

describe("projectForSession", () => {
  test("resolves a session by project id", () => {
    const projects = [project("p1", "/repos/p1"), project("p2", "/repos/p2")]
    const result = projectForSession(session({ id: "s1", directory: "/repos/p1", projectID: "p1" }), projects)
    expect(result?.id).toBe("p1")
  })

  test("never maps a session to the global pseudo-project", () => {
    // A stale global row can carry an unrelated worktree (e.g. the last opened
    // git repo without commits); it must not label global sessions.
    const projects = [project("global", "/repos/Record #1"), project("p1", "/repos/p1")]
    const result = projectForSession(session({ id: "s1", directory: "C:/Users/camal", projectID: "global" }), projects)
    expect(result).toBeUndefined()
  })

  test("still matches a project by directory or sandbox", () => {
    const projects = [project("p1", "/repos/p1", ["C:\\worktrees\\p1-wt"])]
    const byWorktree = projectForSession(session({ id: "s1", directory: "/repos/p1", projectID: "other" }), projects)
    const bySandbox = projectForSession(
      session({ id: "s2", directory: "C:\\worktrees\\p1-wt/", projectID: "other" }),
      projects,
    )
    expect(byWorktree?.id).toBe("p1")
    expect(bySandbox?.id).toBe("p1")
  })
})
