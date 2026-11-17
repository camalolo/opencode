export * as ToolRanking from "./ranking"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Ref, Schedule } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"

/** How far back tool usage is counted. */
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000

/** A full windowed rescan on a large database costs a few seconds on the database worker. */
const REFRESH_MS = 10 * 60 * 1000

type Usage = {
  readonly global: ReadonlyMap<string, number>
  readonly byDirectory: ReadonlyMap<string, ReadonlyMap<string, number>>
}

type Row = { name: string | null; directory: string | null; count: number }

/**
 * Tool usage counts derived from recorded tool parts. Code-mode child calls
 * are counted from the `execute` part's recorded call list so they keep
 * informing catalog ranking after direct tool calls disappear.
 */
export interface Interface {
  /** Usage counts for one directory, falling back to all-directory totals. */
  readonly counts: (directory?: string) => Effect.Effect<ReadonlyMap<string, number>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ToolRanking") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const usage = yield* Ref.make<Usage>({ global: new Map(), byDirectory: new Map() })

    const scan = Effect.fn("ToolRanking.scan")(function* () {
      const cutoff = Date.now() - WINDOW_MS
      const [direct, nested] = yield* Effect.all([
        database.db.all<Row>(sql`
          SELECT json_extract(p.data, '$.tool') AS name, s.directory AS directory, COUNT(*) AS count
          FROM part p
          LEFT JOIN session s ON s.id = p.session_id
          WHERE json_extract(p.data, '$.type') = 'tool' AND p.time_created >= ${cutoff}
          GROUP BY name, directory
        `),
        database.db.all<Row>(sql`
          SELECT json_extract(c.value, '$.tool') AS name, s.directory AS directory, COUNT(*) AS count
          FROM part p, json_each(json_extract(p.data, '$.metadata.toolCalls')) c
          LEFT JOIN session s ON s.id = p.session_id
          WHERE json_extract(p.data, '$.type') = 'tool'
            AND json_type(p.data, '$.metadata.toolCalls') = 'array'
            AND p.time_created >= ${cutoff}
          GROUP BY name, directory
        `),
      ])

      const global = new Map<string, number>()
      const byDirectory = new Map<string, Map<string, number>>()
      for (const row of [...direct, ...nested]) {
        if (!row.name) continue
        global.set(row.name, (global.get(row.name) ?? 0) + row.count)
        if (!row.directory) continue
        const counts = byDirectory.get(row.directory) ?? new Map<string, number>()
        counts.set(row.name, (counts.get(row.name) ?? 0) + row.count)
        byDirectory.set(row.directory, counts)
      }
      yield* Ref.set(usage, { global, byDirectory })
    })

    const guarded = scan().pipe(Effect.catchCause((cause) => Effect.logWarning("tool usage scan failed", { cause })))

    // The boot scan may run before the process has done any work (tests seed
    // rows afterwards), so the first reader also triggers one scan of its own.
    const firstScan = yield* Effect.cached(guarded)

    yield* Effect.forkScoped(guarded.pipe(Effect.repeat(Schedule.spaced(REFRESH_MS)), Effect.ignore))

    const counts: Interface["counts"] = Effect.fnUntraced(function* (directory?: string) {
      const current = yield* Ref.get(usage)
      if (current.global.size === 0) yield* firstScan
      const latest = yield* Ref.get(usage)
      const local = directory ? latest.byDirectory.get(directory) : undefined
      return local && local.size > 0 ? local : latest.global
    })

    return Service.of({ counts })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
