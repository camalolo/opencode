import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261114023209_sleep_variant",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_sleep\` ADD \`variant\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
