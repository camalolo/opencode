import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261114112602_sleep_loop_forever",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_sleep\` ADD \`loop_forever\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
