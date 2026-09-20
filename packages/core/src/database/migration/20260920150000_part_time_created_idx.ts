import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260920150000_part_time_created_idx",
  up(tx) {
    return Effect.gen(function* () {
      // The search index's refresh window re-reads recent parts every few
      // seconds; without this index that query scans the whole part table
      // and blocks the event loop while sorting by hand.
      yield* tx.run(`CREATE INDEX \`part_time_created_idx\` ON \`part\` (\`time_created\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
