import type { Part } from "@opencode-ai/sdk/v2"

export type ReasoningDisplay = "off" | "auto" | "on"

export function normalizeReasoningDisplay(value: ReasoningDisplay | boolean | undefined): ReasoningDisplay {
  if (value === "auto" || value === "on" || value === "off") return value
  if (value === false) return "off"
  // Component-level default: surfaces that don't pass the prop (share pages)
  // showed all reasoning before the tri-state existed.
  return "on"
}

/**
 * Whether one assistant message's reasoning parts should render. In "auto" the
 * reasoning shows only when the message carries no visible text answer: a
 * silent tool-call step keeps its reasoning, a replied step hides it.
 */
export function showsReasoning(parts: Part[], display: ReasoningDisplay) {
  if (display === "off") return false
  if (!parts.some((part) => part.type === "reasoning" && !!part.text?.trim())) return false
  if (display === "on") return true
  return !parts.some((part) => part.type === "text" && !!part.text?.trim())
}
