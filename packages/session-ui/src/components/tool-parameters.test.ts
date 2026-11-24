import { describe, expect, test } from "bun:test"
import { hasToolParameters, toolParametersText } from "./tool-parameters"

describe("hasToolParameters", () => {
  test("accepts a non-empty object", () => {
    expect(hasToolParameters({ filePath: "package.json" })).toBe(true)
  })

  test("rejects empty objects", () => {
    expect(hasToolParameters({})).toBe(false)
  })

  test("rejects missing values", () => {
    expect(hasToolParameters(undefined)).toBe(false)
    expect(hasToolParameters(null)).toBe(false)
    expect(hasToolParameters("text")).toBe(false)
    expect(hasToolParameters([1])).toBe(false)
  })
})

describe("toolParametersText", () => {
  test("formats nested objects with two-space indentation", () => {
    expect(toolParametersText({ limit: 12, nested: { selector: "main", index: 2 } })).toBe(
      [
        "{",
        '  "limit": 12,',
        '  "nested": {',
        '    "selector": "main",',
        '    "index": 2',
        "  }",
        "}",
      ].join("\n"),
    )
  })

  test("returns an empty string for missing values", () => {
    expect(toolParametersText(undefined)).toBe("")
  })

  test("returns plain strings unchanged", () => {
    expect(toolParametersText("inline")).toBe("inline")
  })
})
