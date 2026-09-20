import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260920160000_part_time_updated_idx",
  up(tx) {
    return Effect.gen(function* () {
      // The search index's refresh cursor walks parts by time_updated; without
      // this index that query scans the whole part table every tick.
      yield* tx.run(`CREATE INDEX \`part_time_updated_idx\` ON \`part\` (\`time_updated\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
