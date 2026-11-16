import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ModelsDev } from "@opencode-ai/core/models-dev"
import { Effect } from "effect"
import { FetchHttpClient, HttpClient } from "effect/unstable/http"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { disposeAllInstances } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Env } from "../../src/env"
import { Plugin } from "../../src/plugin/index"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { Model } from "@/provider/provider"
import { applyDiscoveredModels, discoverModelsFromEndpoint, Provider } from "@/provider/provider"

function model(id: string, context = 1000): Model {
  return {
    id: id as Model["id"],
    providerID: "p" as Model["providerID"],
    name: id,
    family: "",
    api: { id, npm: "@ai-sdk/openai-compatible", url: "https://proxy" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context, output: 0 },
    capabilities: {
      temperature: false,
      reasoning: false,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: {},
  }
}

describe("applyDiscoveredModels", () => {
  test("adds unknown ids and tracks them as discovery-owned", () => {
    const mine = new Set<string>()
    const { models, changed } = applyDiscoveredModels({
      current: { declared: model("declared") },
      upstream: { "new-a": model("new-a"), "new-b": model("new-b") },
      mine,
    })
    expect(changed).toBe(2)
    expect(Object.keys(models).sort()).toEqual(["declared", "new-a", "new-b"])
    expect([...mine].sort()).toEqual(["new-a", "new-b"])
  })

  test("refreshes metadata for discovery-owned ids", () => {
    const mine = new Set(["disc"])
    const { models, changed } = applyDiscoveredModels({
      current: { disc: model("disc", 1000) },
      upstream: { disc: model("disc", 200000) },
      mine,
    })
    expect(changed).toBe(1)
    expect(models["disc"]?.limit.context).toBe(200000)
  })

  test("trims discovery-owned ids that vanished upstream", () => {
    const mine = new Set(["gone", "kept"])
    const { models, changed } = applyDiscoveredModels({
      current: { gone: model("gone"), kept: model("kept"), declared: model("declared") },
      upstream: { kept: model("kept") },
      mine,
    })
    // 1 trim + 1 metadata refresh of the surviving kept model
    expect(changed).toBe(2)
    expect(models["gone"]).toBeUndefined()
    expect(models["kept"]).toBeDefined()
    expect(models["declared"]).toBeDefined()
    expect([...mine]).toEqual(["kept"])
  })

  test("never touches declared ids even when upstream lists them", () => {
    const mine = new Set<string>()
    const declared = model("declared", 1000000)
    const { models, changed } = applyDiscoveredModels({
      current: { declared },
      upstream: { declared: model("declared", 1) },
      mine,
    })
    expect(changed).toBe(0)
    expect(models["declared"]).toBe(declared)
  })

  test("respects whitelist and blacklist for new ids", () => {
    const mine = new Set<string>()
    const { models, changed } = applyDiscoveredModels({
      current: {},
      upstream: { allowed: model("allowed"), blocked: model("blocked"), unlisted: model("unlisted") },
      whitelist: ["allowed"],
      blacklist: ["blocked"],
      mine,
    })
    expect(changed).toBe(1)
    expect(Object.keys(models)).toEqual(["allowed"])
  })
})

// Real HTTP server serving /models payloads — discovery hits it through the
// normal fetch stack, so auth and status handling stay exercised.
const endpointPayload: { data: Array<Record<string, unknown>> } = { data: [] }
const endpointServer = Bun.serve({
  port: 0,
  fetch: (req) => {
    if (req.headers.get("authorization") !== "Bearer ik-test") return new Response("unauthorized", { status: 401 })
    return Response.json(endpointPayload)
  },
})
afterAll(() => endpointServer.stop(true))

const parseEndpoint = (apiKey?: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient
      return yield* discoverModelsFromEndpoint({
        http,
        providerID: ProviderV2.ID.make("proxy"),
        baseURL: `http://127.0.0.1:${endpointServer.port}/v1`,
        apiKey,
        known: new Set(),
      })
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  )

describe("discoverModelsFromEndpoint", () => {
  test("maps a proxy-style payload: pricing, limits, reasoning levels, modalities", async () => {
    endpointPayload.data = [
      {
        id: "glm-5.3-flash",
        object: "model",
        owned_by: "inference-proxy",
        name: "GLM 5.3 Flash 1017 (opencode-go)",
        context_length: 200000,
        default_max_tokens: 131072,
        can_reason: true,
        reasoning_levels: ["low", "medium", "high"],
        input_modalities: ["text", "image", "pdf"],
        pricing: { input_per_1m: 0.6, output_per_1m: 2.2, cached_input_per_1m: 0.11 },
      },
      { id: "text-only", object: "model", name: "Text Only", input_modalities: ["text"] },
      { id: "retired", object: "model", name: "Retired", active: false },
      { id: "voice", object: "model", name: "Voice", output_modalities: ["audio"] },
    ]
    const result = await parseEndpoint("ik-test")
    expect(result).toBeDefined()
    expect(result!.signature).toContain("glm-5.3-flash")

    const glm = result!.models["glm-5.3-flash"]
    expect(glm).toBeDefined()
    expect(glm.cost).toEqual({ input: 0.6, output: 2.2, cache: { read: 0.11, write: 0 } })
    expect(glm.limit).toEqual({ context: 200000, output: 131072 })
    expect(glm.capabilities.attachment).toBe(true)
    expect(glm.capabilities.input.image).toBe(true)
    expect(glm.capabilities.input.pdf).toBe(true)
    expect(glm.capabilities.reasoning).toBe(true)
    expect(Object.keys(glm.variants ?? {})).toEqual(expect.arrayContaining(["low", "medium", "high"]))
    expect(glm.name).toBe("GLM 5.3 Flash 1017 (opencode-go)")
    expect(glm.capabilities.interleaved).toEqual({ field: "reasoning_content" })

    const textOnly = result!.models["text-only"]
    expect(textOnly).toBeDefined()
    expect(textOnly.capabilities.attachment).toBe(false)
    expect(textOnly.capabilities.reasoning).toBe(false)
    expect(textOnly.cost.input).toBe(0)
    expect(textOnly.capabilities.interleaved).toBe(false)

    expect(result!.models["retired"]).toBeUndefined()
    expect(result!.models["voice"]).toBeUndefined()
  })

  test("reported reasoning levels win over transform heuristics", async () => {
    // A glm-family id: the transform's heuristic set is empty for it, so the
    // endpoint's explicit levels are the only source of variants.
    endpointPayload.data = [
      {
        id: "glm-5.3-flash",
        name: "GLM 5.3 Flash",
        can_reason: true,
        reasoning_levels: ["low", "high"],
      },
    ]
    const result = await parseEndpoint("ik-test")
    expect(Object.keys(result!.models["glm-5.3-flash"].variants ?? {})).toEqual(["low", "high"])
  })

  test("parses OpenRouter-style per-token string pricing", async () => {
    endpointPayload.data = [
      {
        id: "or-model",
        name: "OR Model",
        pricing: { prompt: "0.0000015", completion: 0.000002, input_cache_read: "0.00000015" },
      },
    ]
    const result = await parseEndpoint("ik-test")
    expect(result!.models["or-model"].cost).toEqual({
      input: 1.5,
      output: 2,
      cache: { read: 0.15, write: 0 },
    })
  })

  test("maps the models.dev-shaped card: cost, limit, temperature, dialect, effort fallbacks", async () => {
    endpointPayload.data = [
      {
        id: "card-model",
        name: "Card Model",
        context_length: 1048576,
        cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0 },
        limit: { context: 1000000, output: 384000 },
        capabilities: {
          temperature: true,
          tools: { supported: true },
          reasoning: { supported: true, effort: ["low", "high", "max"] },
        },
        api: { "chat-completions": { compatibility: { reasoning_field: "reasoning_content" } } },
      },
    ]
    const result = await parseEndpoint("ik-test")
    const model = result!.models["card-model"]
    expect(model.cost).toEqual({ input: 0.15, output: 0.6, cache: { read: 0.003, write: 0 } })
    expect(model.limit).toEqual({ context: 1048576, output: 384000 })
    expect(model.capabilities.temperature).toBe(true)
    expect(model.capabilities.reasoning).toBe(true)
    expect(model.capabilities.interleaved).toEqual({ field: "reasoning_content" })
    // flat reasoning_levels absent: the card's effort list feeds the variants
    expect(Object.keys(model.variants ?? {})).toEqual(["low", "high", "max"])
  })

  test("accepts mime-typed modalities from the models.dev modalities object", async () => {
    endpointPayload.data = [
      {
        id: "mime-model",
        name: "Mime Model",
        modalities: { input: ["text", "image/jpeg", "application/pdf"], output: ["text"] },
      },
    ]
    const result = await parseEndpoint("ik-test")
    const model = result!.models["mime-model"]
    expect(model.capabilities.attachment).toBe(true)
    expect(model.capabilities.input.image).toBe(true)
    expect(model.capabilities.input.pdf).toBe(true)
    expect(model.capabilities.input.audio).toBe(false)
  })

  test("keeps xAI properties[] pricing as a fallback source", async () => {
    endpointPayload.data = [
      {
        id: "xai-model",
        name: "XAI Model",
        properties: [
          {
            property_id: "price",
            value: [
              { unit: "per M input tokens", price: 3 },
              { unit: "per M output tokens", price: 15 },
            ],
          },
        ],
      },
    ]
    const result = await parseEndpoint("ik-test")
    expect(result!.models["xai-model"].cost).toEqual({
      input: 3,
      output: 15,
      cache: { read: 0, write: 0 },
    })
  })

  test("accepts a bare array body", async () => {
    endpointPayload.data = [{ id: "bare-model", name: "Bare" }]
    const result = await parseEndpoint("ik-test")
    expect(result!.models["bare-model"]).toBeDefined()
  })

  test("requires the bearer key when the endpoint enforces one", async () => {
    endpointPayload.data = [{ id: "secret-model" }]
    const result = await parseEndpoint()
    expect(result).toBeUndefined()
  })
})

// Boot-recovery: a discover-enabled provider whose /models fetch fails at boot
// has zero models and is dropped by the filter loop; a later refresh must
// re-materialize it once the endpoint answers again.
let recoveryMode: "fail" | "ok" = "fail"
const recoveryServer = Bun.serve({
  port: 0,
  fetch: () =>
    recoveryMode === "ok"
      ? Response.json({
          object: "list",
          data: [
            {
              id: "glm-test",
              name: "GLM Test (proxy)",
              context_length: 200000,
              default_max_tokens: 131072,
              can_reason: true,
              input_modalities: ["text", "image"],
              pricing: { input_per_1m: 0.6, output_per_1m: 2.2 },
            },
          ],
        })
      : new Response("boom", { status: 500 }),
})
afterAll(() => recoveryServer.stop(true))

const providerLayer = LayerNode.compile(
  LayerNode.group([
    Provider.node,
    FSUtil.node,
    Env.node,
    Config.node,
    Auth.node,
    Plugin.node,
    ModelsDev.node,
    RuntimeFlags.node,
  ]),
)
const it = testEffect(providerLayer)

afterEach(() => disposeAllInstances())

const proxyTestConfig = {
  provider: {
    "proxy-test": {
      name: "Proxy Test",
      npm: "@ai-sdk/openai-compatible",
      discover: true,
      options: { baseURL: `http://127.0.0.1:${recoveryServer.port}/v1` },
    },
  },
}

it.instance("re-materializes a provider whose boot-time /models fetch failed", () =>
  Effect.gen(function* () {
    const providerID = ProviderV2.ID.make("proxy-test")
    const providers = yield* Provider.use.list()
    expect(providers[providerID]).toBeUndefined()

    recoveryMode = "ok"
    expect(yield* Provider.use.refreshDiscovered()).toBe(1)

    const recovered = (yield* Provider.use.list())[providerID]
    expect(recovered).toBeDefined()
    const glm = recovered.models["glm-test"]
    expect(glm).toBeDefined()
    expect(glm.cost.input).toBe(0.6)
    expect(glm.cost.output).toBe(2.2)
    expect(glm.limit.context).toBe(200000)
    expect(glm.capabilities.attachment).toBe(true)
    expect(glm.capabilities.input.image).toBe(true)

    // Unchanged upstream: a second refresh is a no-op.
    expect(yield* Provider.use.refreshDiscovered()).toBe(0)
  }),
  { config: proxyTestConfig },
)
