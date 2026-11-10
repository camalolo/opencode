import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261110123000_session_unattended",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `session` ADD `unattended` integer;")
    })
  },
} satisfies DatabaseMigration.Migration
