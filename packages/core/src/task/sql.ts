import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Task } from "@opencode-ai/schema/task"
import { Timestamps } from "../database/schema.sql"
import { directoryColumn } from "../database/path"
import { SessionSchema } from "../session/schema"

export const ScheduledTaskTable = sqliteTable(
  "scheduled_task",
  {
    id: text().$type<Task.ID>().primaryKey(),
    directory: directoryColumn().notNull(),
    name: text().notNull(),
    description: text(),
    cron: text().notNull(),
    timezone: text(),
    agent: text(),
    model: text({ mode: "json" }).$type<{ id: string; providerID: string; variant?: string }>(),
    prompt: text().notNull(),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    run_timeout_ms: integer(),
    retain_runs: integer().notNull().default(20),
    next_run_at: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("scheduled_task_directory_name_idx").on(table.directory, table.name),
    index("scheduled_task_enabled_next_run_idx").on(table.enabled, table.next_run_at),
  ],
)

export const ScheduledTaskRunTable = sqliteTable(
  "scheduled_task_run",
  {
    id: text().$type<Task.RunID>().primaryKey(),
    task_id: text()
      .$type<Task.ID>()
      .notNull()
      .references(() => ScheduledTaskTable.id, { onDelete: "cascade" }),
    session_id: text().$type<SessionSchema.ID>(),
    status: text().$type<Task.RunStatus>().notNull(),
    trigger: text().$type<Task.RunTrigger>().notNull(),
    scheduled_at: integer().notNull(),
    time_started: integer(),
    time_completed: integer(),
    error: text(),
    time_created: integer().notNull().$default(() => Date.now()),
  },
  (table) => [
    index("scheduled_task_run_task_status_idx").on(table.task_id, table.status),
    index("scheduled_task_run_task_time_created_idx").on(table.task_id, table.time_created),
  ],
)
