import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260918061730_part_search_text",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`part_search_text\` (
          \`part_rowid\` integer NOT NULL,
          \`part_id\` text NOT NULL,
          \`ordinal\` integer NOT NULL,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`source\` text NOT NULL,
          \`label\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`text\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`part_search_text_field_idx\` ON \`part_search_text\` (\`part_id\`,\`ordinal\`);`,
      )
      yield* tx.run(`CREATE INDEX \`part_search_text_part_rowid_idx\` ON \`part_search_text\` (\`part_rowid\`);`)
      yield* tx.run(`CREATE INDEX \`part_search_text_time_idx\` ON \`part_search_text\` (\`time_created\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
