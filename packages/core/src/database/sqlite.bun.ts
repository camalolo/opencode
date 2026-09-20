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
  ): Effect.Effect<Array<Record<string, unknown>>, SqlError>
  values(
    query: string,
    params: ReadonlyArray<unknown>,
    safeIntegers: boolean | undefined,
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
 * Runs the connection inside a Worker thread: statement execution leaves the
 * main event loop untouched, so long SQLite work (index batches, migrations,
 * big reads) cannot stall HTTP, SSE, or JS. Requests are answered in FIFO
 * order over one message queue, which preserves the exact semantics of the
 * single in-thread connection this replaces.
 */
const makeWorkerExec = (options: Config) =>
  Effect.gen(function* () {
    let worker: Worker | null = null
    let alive = false
    let seq = 0
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: SqlError) => void }>()

    const failAll = (message: string) => {
      if (!alive) return
      alive = false
      const cause = new Error(message)
      for (const entry of pending.values())
        entry.reject(new SqlError({ reason: classifySqliteError(cause, { message, operation: "execute" }) }))
      pending.clear()
    }

    const spawn = () => {
      worker = new Worker(new URL("./sqlite.worker.ts", import.meta.url))
      alive = true
      worker.onmessage = (event: MessageEvent) => {
        const message = event.data as SqliteWorkerResponse
        const entry = pending.get(message.id)
        if (!entry) return
        pending.delete(message.id)
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
      worker.onerror = (event: ErrorEvent) => failAll(event.message || "sqlite worker error")
      const exitable = worker as unknown as { onexit?: ((event: unknown) => void) | null }
      exitable.onexit = () => failAll("sqlite worker exited")
    }

    const send = <A>(message: RequestInput): Effect.Effect<A, SqlError> =>
      Effect.callback<A, SqlError>((resume) => {
        if (!worker || !alive) {
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
        const id = ++seq
        worker.postMessage({ ...message, id })
        pending.set(id, {
          resolve: (value) => resume(Effect.succeed(value as A)),
          reject: (error) => resume(Effect.fail(error)),
        })
      })

    spawn()
    yield* send<undefined>({
      op: "open",
      filename: options.filename,
      readonly: options.readonly,
      create: options.create,
      disableWAL: options.disableWAL,
    })

    return identity<Exec>({
      run: (query, params, safeIntegers) =>
        send<Array<Record<string, unknown>>>({ op: "run", sql: query, params: [...params], safeIntegers: !!safeIntegers }),
      values: (query, params, safeIntegers) =>
        send<Array<unknown[]>>({ op: "values", sql: query, params: [...params], safeIntegers: !!safeIntegers }),
      export: send<Uint8Array>({ op: "export" }),
      loadExtension: (path) => send<void>({ op: "loadExtension", path }),
      close: send<void>({ op: "close" }),
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

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) =>
        exec.run(query, params, Context.get(fiber.context, Client.SafeIntegers)),
      )

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) =>
        exec.values(query, params, Context.get(fiber.context, Client.SafeIntegers)),
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
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
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
