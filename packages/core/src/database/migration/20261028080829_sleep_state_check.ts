import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028080829_sleep_state_check",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_sleep\` ADD \`observe\` text;`)
      yield* tx.run(`ALTER TABLE \`session_sleep\` ADD \`predicate\` text;`)
      yield* tx.run(`ALTER TABLE \`session_sleep\` ADD \`met_example\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
