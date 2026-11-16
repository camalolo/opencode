import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLM, LLMEvent, mapFinishReason } from "../src"
import { Auth, LLMClient } from "../src/route"
import * as OpenAIChat from "../src/protocols/openai-chat"
import { it } from "./lib/effect"
import { scriptedResponses } from "./lib/http"
import { finishChunk } from "./lib/openai-chunks"
import { sseEvents } from "./lib/sse"

const model = OpenAIChat.route
  .with({ endpoint: { baseURL: "https://api.openai.test/v1/" }, auth: Auth.bearer("test") })
  .model({ id: "glm-5.3-flash" })

describe("mapFinishReason", () => {
  test("maps the OpenAI standard set", () => {
    expect(mapFinishReason("stop")).toBe("stop")
    expect(mapFinishReason("length")).toBe("length")
    expect(mapFinishReason("content_filter")).toBe("content-filter")
    expect(mapFinishReason("function_call")).toBe("tool-calls")
    expect(mapFinishReason("tool_calls")).toBe("tool-calls")
  })

  test("maps Z.AI provider-native finish reasons", () => {
    // Undocumented inference-guard cutoff for repetition loops.
    expect(mapFinishReason("repeat")).toBe("repetition")
    expect(mapFinishReason("sensitive")).toBe("content-filter")
    expect(mapFinishReason("sensitivity")).toBe("content-filter")
    expect(mapFinishReason("network_error")).toBe("error")
    expect(mapFinishReason("model_context_window_exceeded")).toBe("length")
  })

  test("maps null, undefined, and unknown strings to unknown", () => {
    expect(mapFinishReason(null)).toBe("unknown")
    expect(mapFinishReason(undefined)).toBe("unknown")
    expect(mapFinishReason("some_future_sentinel")).toBe("unknown")
  })
})

describe("OpenAI Chat provider-native finish reasons", () => {
  const streamReason = (reason: string) =>
    Effect.gen(function* () {
      const layer = scriptedResponses([sseEvents(finishChunk(reason))])
      const events = Array.from(
        yield* LLMClient.stream(LLM.request({ id: "req_1", model, prompt: "Hi." })).pipe(
          Stream.runCollect,
          Effect.provide(layer),
        ),
      )
      return events.find(LLMEvent.is.finish)?.reason
    })

  it.effect("maps a Z.AI repetition cutoff to repetition", () =>
    Effect.gen(function* () {
      expect(yield* streamReason("repeat")).toBe("repetition")
    }),
  )

  it.effect("maps a Z.AI sensitivity cutoff to content-filter", () =>
    Effect.gen(function* () {
      expect(yield* streamReason("sensitive")).toBe("content-filter")
    }),
  )

  it.effect("maps a Z.AI network error to error", () =>
    Effect.gen(function* () {
      expect(yield* streamReason("network_error")).toBe("error")
    }),
  )

  it.effect("maps a Z.AI context-window cutoff to length", () =>
    Effect.gen(function* () {
      expect(yield* streamReason("model_context_window_exceeded")).toBe("length")
    }),
  )
})
