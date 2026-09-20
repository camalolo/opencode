// Worker entry that owns the bun:sqlite connection so statement execution
// never blocks the main thread's event loop. Receives one request at a time
// (the main thread's semaphore + FIFO postMessage preserve ordering), runs it
// synchronously, and posts the result or a classified error reason back.

import { Database } from "bun:sqlite"

export type SqliteWorkerRequest =
  | { id: number; op: "open"; filename: string; readonly?: boolean; create?: boolean; disableWAL?: boolean }
  | { id: number; op: "run" | "values"; sql: string; params: unknown[]; safeIntegers: boolean }
  | { id: number; op: "export" }
  | { id: number; op: "loadExtension"; path: string }
  | { id: number; op: "close" }

export type SqliteWorkerResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; reason: string }

const scope = globalThis as unknown as {
  postMessage: (message: unknown) => void
  onmessage: ((event: MessageEvent) => void) | null
}

let native: Database | null = null

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as SqliteWorkerRequest
  try {
    switch (message.op) {
      case "open": {
        native = new Database(message.filename, {
          readonly: message.readonly,
          readwrite: !message.readonly,
          create: message.create ?? true,
        })
        if (message.disableWAL !== true) native.run("PRAGMA journal_mode = WAL;")
        scope.postMessage({ id: message.id, ok: true } satisfies SqliteWorkerResponse)
        break
      }
      case "run":
      case "values": {
        const statement = native!.query(message.sql)
        // @ts-ignore bun-types missing safeIntegers method, fixed in https://github.com/oven-sh/bun/pull/26627
        if (message.safeIntegers) statement.safeIntegers(true)
        const result =
          message.op === "values"
            ? ((statement.values(...(message.params as any)) ?? []) as unknown[])
            : ((statement.all(...(message.params as any)) ?? []) as unknown)
        scope.postMessage({ id: message.id, ok: true, result } satisfies SqliteWorkerResponse)
        break
      }
      case "export": {
        scope.postMessage({ id: message.id, ok: true, result: native!.serialize() } satisfies SqliteWorkerResponse)
        break
      }
      case "loadExtension": {
        native!.loadExtension(message.path)
        scope.postMessage({ id: message.id, ok: true } satisfies SqliteWorkerResponse)
        break
      }
      case "close": {
        native?.close()
        native = null
        scope.postMessage({ id: message.id, ok: true } satisfies SqliteWorkerResponse)
        break
      }
    }
  } catch (cause) {
    // Classification happens main-thread-side from the original message, so
    // only a plain string crosses the worker boundary.
    const text = cause instanceof Error ? cause.message : String(cause)
    scope.postMessage({ id: message.id, ok: false, reason: text } satisfies SqliteWorkerResponse)
  }
}
