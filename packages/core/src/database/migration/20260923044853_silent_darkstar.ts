import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923044853_silent_darkstar",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`project_list\` (
          \`worktree\` text PRIMARY KEY,
          \`position\` integer NOT NULL,
          \`expanded\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
