import { describe, expect, test } from "bun:test"
import { readPartText, reasoningIsShort } from "./message-part-text"

describe("readPartText", () => {
  test("returns empty string when accum is undefined and part text is undefined", () => {
    expect(readPartText(undefined, { id: "part_1" })).toBe("")
  })

  test("returns trimmed part text when accum is undefined", () => {
    expect(readPartText(undefined, { id: "part_1", text: "  hello  " })).toBe("hello")
  })

  test("prefers accum value over part text when accum has a hit", () => {
    expect(readPartText({ part_1: "  from accum  " }, { id: "part_1", text: "from part" })).toBe("from accum")
  })

  test("falls back to part text when accum misses", () => {
    expect(readPartText({ other_part: "ignored" }, { id: "part_1", text: "  from part  " })).toBe("from part")
  })

  test("returns empty string for whitespace-only text", () => {
    expect(readPartText(undefined, { id: "part_1", text: "   \n\t  " })).toBe("")
  })

  test("trims leading and trailing whitespace", () => {
    expect(readPartText(undefined, { id: "part_1", text: "\n  body  \n" })).toBe("body")
  })
})

describe("reasoningIsShort", () => {
  test("text without terminator reads as one sentence", () => {
    expect(reasoningIsShort("Checking the request")).toBe(true)
  })

  test("single sentence is short", () => {
    expect(reasoningIsShort("Checking the request.\n")).toBe(true)
  })

  test("two sentences are not short", () => {
    expect(reasoningIsShort("Checking the request. Planning next steps.")).toBe(false)
  })

  test("question and exclamation marks count as terminators", () => {
    expect(reasoningIsShort("Why does this fail? Let me look!")).toBe(false)
  })

  test("ellipsis counts as a terminator", () => {
    expect(reasoningIsShort("Hmm… wait…")).toBe(false)
  })

  test("newlines collapse before counting", () => {
    expect(reasoningIsShort("Line one\nLine two")).toBe(true)
  })

  test("whitespace-only text is short", () => {
    expect(reasoningIsShort("   \n\t  ")).toBe(true)
  })
})
