import { describe, expect, test } from "bun:test"
import type { Part } from "@opencode-ai/sdk/v2"
import { normalizeReasoningDisplay, showsReasoning } from "./reasoning-display"

const reasoning = (text: string): Part => ({
  id: "r1",
  type: "reasoning",
  text,
  sessionID: "ses_1",
  messageID: "msg_1",
  time: { start: 1 },
})

const text = (value: string): Part => ({
  id: "t1",
  type: "text",
  text: value,
  sessionID: "ses_1",
  messageID: "msg_1",
  time: { start: 1 },
})

const tool = (): Part => ({
  id: "tool1",
  type: "tool",
  sessionID: "ses_1",
  messageID: "msg_1",
  callID: "call1",
  tool: "read",
  state: {
    status: "completed",
    input: {},
    output: "",
    title: "read",
    metadata: {},
    time: { start: 0, end: 0 },
  },
})

describe("normalizeReasoningDisplay", () => {
  test("passes modes through", () => {
    expect(normalizeReasoningDisplay("off")).toBe("off")
    expect(normalizeReasoningDisplay("auto")).toBe("auto")
    expect(normalizeReasoningDisplay("on")).toBe("on")
  })

  test("maps the legacy boolean setting", () => {
    expect(normalizeReasoningDisplay(true)).toBe("on")
    expect(normalizeReasoningDisplay(false)).toBe("off")
  })

  test("defaults to on when unset, matching the pre-tri-state component default", () => {
    expect(normalizeReasoningDisplay(undefined)).toBe("on")
  })
})

describe("showsReasoning", () => {
  test("never shows in off mode", () => {
    expect(showsReasoning([reasoning("thinking"), tool()], "off")).toBe(false)
  })

  test("always shows non-empty reasoning in on mode", () => {
    expect(showsReasoning([reasoning("thinking"), text("the answer")], "on")).toBe(true)
    expect(showsReasoning([text("the answer")], "on")).toBe(false)
  })

  test("auto shows reasoning for a tool-only message", () => {
    expect(showsReasoning([reasoning("thinking"), tool()], "auto")).toBe(true)
  })

  test("auto hides reasoning when the message carries a text answer", () => {
    expect(showsReasoning([reasoning("thinking"), tool(), text("the answer")], "auto")).toBe(false)
  })

  test("auto ignores empty reasoning and whitespace-only text", () => {
    expect(showsReasoning([reasoning("   "), tool()], "auto")).toBe(false)
    expect(showsReasoning([reasoning("thinking"), text("  \n  ")], "auto")).toBe(true)
  })

  test("a message without reasoning never shows any", () => {
    expect(showsReasoning([tool(), text("the answer")], "auto")).toBe(false)
    expect(showsReasoning([], "auto")).toBe(false)
  })
})
