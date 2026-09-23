import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import { Timestamps } from "../database/schema.sql"
import { ProjectSchema } from "./schema"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectSchema.ID>().primaryKey(),
  worktree: DatabasePath.absoluteColumn().notNull(),
  vcs: text(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: integer(),
  sandboxes: DatabasePath.absoluteArrayColumn().notNull(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})

export const ProjectDirectoryTable = sqliteTable(
  "project_directory",
  {
    project_id: text()
      .$type<ProjectSchema.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: DatabasePath.absoluteColumn().notNull(),
    type: text().$type<"main" | "root" | "git_worktree">(),
    strategy: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.directory] })],
)

// Server-maintained list of projects opened from the web UI. Kept separate
// from ProjectTable: rows there are auto-created whenever any instance opens
// a directory (CLI/TUI included), while this list only tracks what web
// clients explicitly opened. Array position is the sidebar order.
export const ProjectListTable = sqliteTable("project_list", {
  worktree: DatabasePath.absoluteColumn().primaryKey(),
  position: integer().notNull(),
  expanded: integer({ mode: "boolean" })
    .notNull()
    .$default(() => true),
  ...Timestamps,
})
