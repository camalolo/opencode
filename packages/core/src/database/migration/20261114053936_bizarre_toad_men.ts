import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261114053936_bizarre_toad_men",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`compaction_threshold\` real;`)
    })
  },
} satisfies DatabaseMigration.Migration
