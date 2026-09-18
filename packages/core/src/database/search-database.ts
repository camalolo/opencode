export * as SearchDatabase from "./search-database"

import { sql } from "drizzle-orm"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Effect, Layer } from "effect"
import { Database } from "./database"
import { makeGlobalNode } from "../effect/app-node"
import type { SessionV1 } from "../v1/session"
import type { SessionSchema } from "../session/schema"

// The transcript search index is derived, rebuildable data, so it lives in its
// own SQLite file: SQLite locks are per-file, which keeps indexer write
// transactions from ever contending with session persistence on opencode.db.

/**
 * Searchable text extracted from parts, one row per field (a tool part yields
 * separate input and output rows). The `part_search` FTS5 trigram virtual
 * table indexes the text column with content='part_search_text'. This table
 * has no primary key on purpose: its implicit rowid is the FTS content_rowid.
 * (part_id, ordinal) is unique so concurrent indexers can race safely.
 */
export const PartSearchTextTable = sqliteTable("part_search_text", {
  part_rowid: integer().notNull(),
  part_id: text().$type<SessionV1.PartID>().notNull(),
  ordinal: integer().notNull(),
  session_id: text().$type<SessionSchema.ID>().notNull(),
  project_id: text().notNull(),
  source: text().$type<"user" | "assistant" | "reasoning" | "tools">().notNull(),
  label: text().notNull(),
  time_created: integer().notNull(),
  text: text().notNull(),
})

export interface Interface {
  db: EffectDrizzleSqlite.EffectSQLiteDatabase
}

export class Service extends Context.Service<Service, Interface>()("@opencode/session/SearchDatabase") {}

export function path() {
  const main = Database.path()
  // :memory: (tests) cannot be suffixed or it stops being an anonymous database.
  if (main === ":memory:") return main
  return main.endsWith(".db") ? main.slice(0, -".db".length) + "-search.db" : main + "-search.db"
}

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")

    // drizzle cannot express virtual tables, and this file has no migration
    // journal, so the derived schema is ensured idempotently at boot.
    yield* db.run(`
      CREATE TABLE IF NOT EXISTS \`part_search_text\` (
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
    yield* db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS \`part_search_text_field_idx\` ON \`part_search_text\` (\`part_id\`,\`ordinal\`);`,
    )
    yield* db.run(`CREATE INDEX IF NOT EXISTS \`part_search_text_part_rowid_idx\` ON \`part_search_text\` (\`part_rowid\`);`)
    yield* db.run(`CREATE INDEX IF NOT EXISTS \`part_search_text_session_idx\` ON \`part_search_text\` (\`session_id\`);`)
    yield* db.run(`CREATE INDEX IF NOT EXISTS \`part_search_text_time_idx\` ON \`part_search_text\` (\`time_created\`);`)
    yield* db
      .run(
        sql`CREATE VIRTUAL TABLE IF NOT EXISTS part_search USING fts5(text, content='part_search_text', content_rowid='rowid', tokenize='trigram')`,
      )
      .pipe(Effect.orDie)

    return { db }
  }).pipe(Effect.orDie),
)

export const node = makeGlobalNode({ service: Service, layer: layer.pipe(Layer.provide(sqliteLayer({ filename: path() }))), deps: [Database.node] })
