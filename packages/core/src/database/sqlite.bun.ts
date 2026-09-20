import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite } from "./sqlite"
import type { SqliteWorkerRequest, SqliteWorkerResponse } from "./sqlite.worker"

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@opencode-ai/core/database/SqliteBun" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

/** Omit over a discriminated union keeps each member's own shape. */
type RequestInput = SqliteWorkerRequest extends infer T ? (T extends unknown ? Omit<T, "id"> : never) : never

interface Exec {
  run(
    query: string,
    params: ReadonlyArray<unknown>,
    safeIntegers: boolean | undefined,
    txDepth: number,
  ): Effect.Effect<Array<Record<string, unknown>>, SqlError>
  values(
    query: string,
    params: ReadonlyArray<unknown>,
    safeIntegers: boolean | undefined,
    txDepth: number,
  ): Effect.Effect<Array<unknown[]>, SqlError>
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly close: Effect.Effect<void, SqlError>
}

const makeSyncExec = (native: Database): Exec => ({
  run(query, params, safeIntegers) {
    const statement = native.query(query)
    // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
    statement.safeIntegers(safeIntegers)
    try {
      return Effect.succeed((statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>)
    } catch (cause) {
      return Effect.fail(
        new SqlError({
          reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
        }),
      )
    }
  },
  values(query, params, safeIntegers) {
    const statement = native.query(query)
    // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
    statement.safeIntegers(safeIntegers)
    try {
      return Effect.succeed((statement.values(...(params as any)) ?? []) as Array<unknown[]>)
    } catch (cause) {
      return Effect.fail(
        new SqlError({
          reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
        }),
      )
    }
  },
  export: Effect.try({
    try: () => native.serialize(),
    catch: (cause) =>
      new SqlError({
        reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
      }),
  }),
  loadExtension: (path) =>
    Effect.try({
      try: () => native.loadExtension(path),
      catch: (cause) =>
        new SqlError({
          reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
        }),
    }),
  close: Effect.void,
})

// File-backed databases park their worker-backed Exec here while the Native
// service slot holds an opaque stub; make() routes through it without the
// layer composition (or anything downstream) changing shape.
const workerExecs = new Map<string, Exec>()

/**
 * Runs the connection inside Worker threads: statement execution leaves the
 * main event loop untouched, so long SQLite work (index batches, migrations,
 * big reads) cannot stall HTTP, SSE, or JS.
 *
 * Each database gets two workers over the same file (WAL): a writer that owns
 * the read/write connection and receives every message in FIFO order, and a
 * reader for plain SELECTs issued outside transactions while no write is in
 * flight. That bypass condition is what keeps sequential consistency: a read
 * may only skip the writer queue when every write ordered before it has
 * already committed, so it can never observe stale data.
 */
const makeWorkerExec = (options: Config) =>
  Effect.gen(function* () {
    const workers = { writer: null as Worker | null, reader: null as Worker | null }
    const alive = { writer: false, reader: false }
    const seq = { writer: 0, reader: 0 }
    const pending = {
      writer: new Map<number, { resolve: (value: unknown) => void; reject: (error: SqlError) => void }>(),
      reader: new Map<number, { resolve: (value: unknown) => void; reject: (error: SqlError) => void }>(),
    }
    let writesInFlight = 0

    const failAll = (target: "writer" | "reader", message: string) => {
      if (!alive[target]) return
      alive[target] = false
      const cause = new Error(message)
      for (const entry of pending[target].values())
        entry.reject(new SqlError({ reason: classifySqliteError(cause, { message, operation: "execute" }) }))
      pending[target].clear()
    }

    const spawn = (target: "writer" | "reader") => {
      const worker = new Worker(new URL("./sqlite.worker.ts", import.meta.url))
      workers[target] = worker
      alive[target] = true
      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as SqliteWorkerResponse
        const entry = pending[target].get(message.id)
        if (!entry) return
        pending[target].delete(message.id)
        if (message.ok) entry.resolve(message.result)
        else
          entry.reject(
            new SqlError({
              reason: classifySqliteError(new Error(message.reason), {
                message: "Failed to execute statement",
                operation: "execute",
              }),
            }),
          )
      }
      worker.onerror = (event: ErrorEvent) => failAll(target, event.message || "sqlite worker error")
      const exitable = worker as unknown as { onexit?: ((event: unknown) => void) | null }
      exitable.onexit = () => failAll(target, "sqlite worker exited")
    }

    const send = <A>(target: "writer" | "reader", message: RequestInput, countsAsWrite = false): Effect.Effect<A, SqlError> =>
      Effect.callback<A, SqlError>((resume) => {
        const worker = workers[target]
        if (!worker || !alive[target]) {
          resume(
            Effect.fail(
              new SqlError({
                reason: classifySqliteError(new Error("sqlite worker is not running"), {
                  message: "Failed to execute statement",
                  operation: "execute",
                }),
              }),
            ),
          )
          return
        }
        const id = ++seq[target]
        worker.postMessage({ ...message, id })
        if (countsAsWrite) writesInFlight += 1
        pending[target].set(id, {
          resolve: (value) => {
            if (countsAsWrite) writesInFlight -= 1
            resume(Effect.succeed(value as A))
          },
          reject: (error) => {
            if (countsAsWrite) writesInFlight -= 1
            resume(Effect.fail(error))
          },
        })
      })

    spawn("writer")
    yield* send<undefined>(
      "writer",
      {
        op: "open",
        filename: options.filename,
        readonly: options.readonly,
        create: options.create,
        disableWAL: options.disableWAL,
      },
    )
    spawn("reader")
    yield* send<undefined>("reader", {
      op: "open",
      filename: options.filename,
      readonly: options.readonly,
      create: options.create ?? true,
      disableWAL: options.disableWAL,
    })

    // SELECTs outside transactions may use the reader; everything else - and
    // any statement racing an in-flight write - must use the writer queue.
    const isRead = (sql: string) => /^\s*select\b/i.test(sql)
    const target = (sql: string, txDepth: number): "writer" | "reader" => {
      if (txDepth > 0 || !isRead(sql)) return "writer"
      if (writesInFlight > 0 || !alive.reader) return "writer"
      return "reader"
    }

    return identity<Exec>({
      run: (query, params, safeIntegers, txDepth) => {
        const to = target(query, txDepth)
        return send<Array<Record<string, unknown>>>(
          to,
          { op: "run", sql: query, params: [...params], safeIntegers: !!safeIntegers },
          to === "writer",
        )
      },
      values: (query, params, safeIntegers, txDepth) => {
        const to = target(query, txDepth)
        return send<Array<unknown[]>>(
          to,
          { op: "values", sql: query, params: [...params], safeIntegers: !!safeIntegers },
          to === "writer",
        )
      },
      export: send<Uint8Array>("writer", { op: "export" }, true),
      loadExtension: (path) => send<void>("writer", { op: "loadExtension", path }, true),
      close: Effect.andThen(send<void>("reader", { op: "close" }), send<void>("writer", { op: "close" }, true)),
    })
  })

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database
    const exec = options.filename === ":memory:" ? makeSyncExec(native) : workerExecs.get(options.filename)!

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    // Depth of the open transaction holding the semaphore; statements issued
    // inside it (including interleaved ones from other fibers, matching the
    // shared-connection behavior this replaces) must run on the writer.
    let txDepth = 0

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) =>
        exec.run(query, params, Context.get(fiber.context, Client.SafeIntegers), txDepth),
      )

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) =>
        exec.values(query, params, Context.get(fiber.context, Client.SafeIntegers), txDepth),
      )

    const connection = identity<SqliteConnection>({
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
      export: exec.export,
      loadExtension: exec.loadExtension,
    })

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => {
          txDepth += 1
          return Scope.addFinalizer(
            scope,
            Effect.andThen(
              Effect.sync(() => {
                txDepth -= 1
              }),
              semaphore.release(1),
            ),
          )
        }),
        connection,
      )
    })

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.flatMap(acquirer, (_) => _.export),
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
      },
    )

    return client
  })

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      if (config.filename === ":memory:") {
        const native = new Database(config.filename, {
          readonly: config.readonly,
          readwrite: config.readwrite ?? true,
          create: config.create ?? true,
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
        if (config.disableWAL !== true) native.run("PRAGMA journal_mode = WAL;")
        return native
      }
      // File-backed database: the connection lives in the worker thread and
      // statement execution never touches this thread's event loop. The
      // service slot holds an opaque marker; make() picks the Exec up from
      // the side channel. Open failures are defects, matching the in-memory
      // branch where a failed constructor throws.
      const exec = yield* makeWorkerExec(config).pipe(Effect.orDie)
      workerExecs.set(config.filename, exec)
      yield* Effect.addFinalizer(() => Effect.ignore(exec.close))
      return {} as unknown as Database
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

const drizzleLayer = Layer.effect(
  Sqlite.Drizzle,
  Effect.gen(function* () {
    return drizzle({ client: (yield* Sqlite.Native) as Database })
  }),
)

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, Layer.merge(sqliteLayer(config), drizzleLayer).pipe(Layer.provide(native))).pipe(
    Layer.provide(Reactivity.layer),
  )
}
