import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261117044300_event_type_time_idx",
  up(tx) {
    return Effect.gen(function* () {
      // The retention sweep prunes old part/message journal rows with
      // `type in (...) and coalesce(json_extract(...) ...) < cutoff`. Without
      // this index that predicate full-scanned the journal — every pass read
      // every remaining row's blob (60-90s on the largest fleet database),
      // and since all statements serialize behind the database semaphore,
      // the whole server stalled with it on every boot and every sweep. The
      // expression must stay byte-identical to the query's `eventTime`
      // template in event-retention.ts, or the planner won't use the index.
      yield* tx.run(
        `CREATE INDEX IF NOT EXISTS \`event_type_time_idx\` ON \`event\` (\`type\`, coalesce(json_extract(\`data\`, '$.time'), json_extract(\`data\`, '$.info.time.updated')));`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
