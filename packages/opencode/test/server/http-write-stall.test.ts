// Transport-level regression tests for `@effect/platform-node`'s NodeHttpServer.
//
// The platform's response writer waits for a `drain` event when the socket
// buffer fills. A peer that stops reading (sleeping phone, dropped NAT mapping,
// throttled tab) never drains and may never close either, which parked the
// request fiber forever (2026-11-22 wedge: a prompt response sat for 10 hours).
// The patch in patches/@effect%2Fplatform-node@4.0.0-beta.83.patch bounds every
// response write with a stall deadline.
import { afterEach, describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Stream } from "effect"
import { HttpServer, HttpServerResponse } from "effect/unstable/http"
import { NodeHttpServer } from "@effect/platform-node"
import { createServer } from "node:http"
import * as net from "node:net"

const original = process.env.OPENCODE_HTTP_WRITE_STALL_MS

afterEach(() => {
  if (original === undefined) delete process.env.OPENCODE_HTTP_WRITE_STALL_MS
  else process.env.OPENCODE_HTTP_WRITE_STALL_MS = original
})

function server(body: Stream.Stream<string>, state: { completed: boolean }) {
  const app = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => (state.completed = true)))
    return HttpServerResponse.stream(body.pipe(Stream.encodeText), { contentType: "text/plain" })
  })
  return HttpServer.serve(app).pipe(Layer.provideMerge(NodeHttpServer.layer(() => createServer(), { port: 0 })))
}

function port(context: Context.Context<HttpServer.HttpServer>) {
  const address = Context.get(context, HttpServer.HttpServer).address
  if (address._tag !== "TcpAddress") throw new Error("expected a TCP address")
  return address.port
}

/** Reads until `threshold` bytes arrive (or the socket errors). */
const readBytes = (socket: net.Socket, threshold: number) =>
  Effect.callback<void>((resume) => {
    let seen = 0
    const onData = (chunk: Buffer) => {
      seen += chunk.length
      if (seen < threshold) return
      socket.off("data", onData)
      resume(Effect.void)
    }
    socket.on("data", onData)
    socket.on("error", () => resume(Effect.void))
  })

const waitCompleted = (state: { completed: boolean }, attempts: number) =>
  Effect.gen(function* () {
    for (let i = 0; i < attempts; i++) {
      if (state.completed) return
      yield* Effect.sleep("100 millis")
    }
  })

/** Serves `body` to a raw socket, drives `read`, and reports whether the request effect finished. */
const run = (
  body: Stream.Stream<string>,
  state: { completed: boolean },
  read: (socket: net.Socket) => Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(server(body, state))
      const socket = net.connect(port(context), "127.0.0.1")
      yield* Effect.callback<void>((resume) => {
        socket.once("connect", () => resume(Effect.void))
        socket.once("error", () => resume(Effect.void))
      })
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n\r\n")
      yield* read(socket)
      yield* waitCompleted(state, 30)
      const completed = state.completed
      socket.destroy()
      return completed
    }),
  )

describe("HTTP response write", () => {
  test("completes normally when the client reads the body", async () => {
    const state = { completed: false }
    const body = "x".repeat(2 * 1024 * 1024)
    const completed = await Effect.runPromise(run(Stream.make(body), state, (socket) => readBytes(socket, body.length)))
    expect(completed).toBe(true)
  })

  test("aborts instead of parking forever when the client stops reading", async () => {
    process.env.OPENCODE_HTTP_WRITE_STALL_MS = "500"
    const state = { completed: false }
    const body = "x".repeat(64 * 1024 * 1024)
    const completed = await Effect.runPromise(
      run(Stream.make(body), state, (socket) =>
        readBytes(socket, 64 * 1024).pipe(Effect.tap(() => Effect.sync(() => socket.pause()))),
      ),
    )
    expect(completed).toBe(true)
  })

  test("stops pulling an infinite body when the client stops reading", async () => {
    process.env.OPENCODE_HTTP_WRITE_STALL_MS = "500"
    const state = { completed: false }
    const chunk = "y".repeat(64 * 1024)
    const completed = await Effect.runPromise(
      run(Stream.iterate(chunk, (value: string) => value), state, (socket) =>
        readBytes(socket, 64 * 1024).pipe(Effect.tap(() => Effect.sync(() => socket.pause()))),
      ),
    )
    expect(completed).toBe(true)
  })
})
