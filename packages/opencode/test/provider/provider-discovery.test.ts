import { describe, expect, test } from "bun:test"
import type { Model } from "@/provider/provider"
import { applyDiscoveredModels } from "@/provider/provider"

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
