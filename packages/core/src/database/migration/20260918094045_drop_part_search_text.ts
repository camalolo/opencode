import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918094045_drop_part_search_text",
  up(tx) {
    return Effect.gen(function* () {
      // Drop the external-content FTS mirror before its content table.
      yield* tx.run(`DROP TABLE IF EXISTS \`part_search\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`part_search_text\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
