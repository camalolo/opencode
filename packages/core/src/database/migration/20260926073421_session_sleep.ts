import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260926073421_session_sleep",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_sleep\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`condition\` text NOT NULL,
          \`description\` text NOT NULL,
          \`interval_ms\` integer NOT NULL,
          \`check_timeout_ms\` integer NOT NULL,
          \`deadline\` integer NOT NULL,
          \`cwd\` text NOT NULL,
          \`shell\` text,
          \`next_check_at\` integer NOT NULL,
          \`consecutive_failures\` integer DEFAULT 0 NOT NULL,
          \`last_output\` text,
          \`status\` text NOT NULL,
          \`message_id\` text,
          \`delivered_at\` integer,
          \`deliver_attempts\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_finished\` integer,
          CONSTRAINT \`fk_session_sleep_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_sleep_session_status_idx\` ON \`session_sleep\` (\`session_id\`,\`status\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_sleep_due_idx\` ON \`session_sleep\` (\`status\`,\`next_check_at\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_sleep_deliverable_idx\` ON \`session_sleep\` (\`status\`,\`delivered_at\`,\`deliver_attempts\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
