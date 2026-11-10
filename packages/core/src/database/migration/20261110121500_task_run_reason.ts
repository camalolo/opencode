import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261110121500_task_run_reason",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run("ALTER TABLE `scheduled_task_run` ADD `reason` text;")
    })
  },
} satisfies DatabaseMigration.Migration
