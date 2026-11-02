import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261102043430_add_scheduled_task",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`scheduled_task_run\` (
          \`id\` text PRIMARY KEY,
          \`task_id\` text NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`trigger\` text NOT NULL,
          \`scheduled_at\` integer NOT NULL,
          \`time_started\` integer,
          \`time_completed\` integer,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_scheduled_task_run_task_id_scheduled_task_id_fk\` FOREIGN KEY (\`task_id\`) REFERENCES \`scheduled_task\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`scheduled_task\` (
          \`id\` text PRIMARY KEY,
          \`directory\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text,
          \`cron\` text NOT NULL,
          \`timezone\` text,
          \`agent\` text,
          \`model\` text,
          \`prompt\` text NOT NULL,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`run_timeout_ms\` integer,
          \`retain_runs\` integer DEFAULT 20 NOT NULL,
          \`next_run_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_run_task_status_idx\` ON \`scheduled_task_run\` (\`task_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_run_task_time_created_idx\` ON \`scheduled_task_run\` (\`task_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`scheduled_task_directory_name_idx\` ON \`scheduled_task\` (\`directory\`,\`name\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`scheduled_task_enabled_next_run_idx\` ON \`scheduled_task\` (\`enabled\`,\`next_run_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
