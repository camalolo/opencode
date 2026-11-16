import { Schema } from "effect"
import { ProviderMetadata } from "@opencode-ai/schema/llm"

export { ProviderMetadata }

/** Stable string identifier for a protocol implementation. */
export const ProtocolID = Schema.String
export type ProtocolID = Schema.Schema.Type<typeof ProtocolID>

/** Stable string identifier for the runnable route. */
export const RouteID = Schema.String
export type RouteID = Schema.Schema.Type<typeof RouteID>

export const ModelID = Schema.String.pipe(Schema.brand("LLM.ModelID"))
export type ModelID = typeof ModelID.Type

export const ProviderID = Schema.String.pipe(Schema.brand("LLM.ProviderID"))
export type ProviderID = typeof ProviderID.Type

export const ResponseID = Schema.String
export type ResponseID = Schema.Schema.Type<typeof ResponseID>

export const ContentBlockID = Schema.String
export type ContentBlockID = Schema.Schema.Type<typeof ContentBlockID>

export const ToolCallID = Schema.String
export type ToolCallID = Schema.Schema.Type<typeof ToolCallID>

export const ReasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export const ReasoningEffort = Schema.Literals(ReasoningEfforts)
export type ReasoningEffort = Schema.Schema.Type<typeof ReasoningEffort>

export const TextVerbosity = Schema.Literals(["low", "medium", "high"])
export type TextVerbosity = Schema.Schema.Type<typeof TextVerbosity>

export const MessageRole = Schema.Literals(["system", "user", "assistant", "tool"])
export type MessageRole = Schema.Schema.Type<typeof MessageRole>

export const FinishReason = Schema.Literals([
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "error",
  "repetition",
  "unknown",
])
export type FinishReason = Schema.Schema.Type<typeof FinishReason>

// OpenAI-compatible providers leak provider-native finish reasons through the
// wire, and their SSE failure modes surface as these strings instead of HTTP
// errors. Z.AI documents `sensitive`, `network_error`, and
// `model_context_window_exceeded`; its inference guard also emits an
// undocumented `repeat` when it force-cuts a repetition loop. Map the known
// set to canonical reasons so cuts are visible and actionable instead of
// collapsing into `unknown`.
export const mapFinishReason = (reason: string | null | undefined): FinishReason => {
  switch (reason) {
    case "stop":
      return "stop"
    case "length":
      return "length"
    case "content_filter":
      return "content-filter"
    case "function_call":
    case "tool_calls":
      return "tool-calls"
    case "repeat":
      return "repetition"
    case "sensitive":
    case "sensitivity":
      return "content-filter"
    case "network_error":
      return "error"
    case "model_context_window_exceeded":
      return "length"
    default:
      return "unknown"
  }
}

export const JsonSchema = Schema.Record(Schema.String, Schema.Unknown)
export type JsonSchema = Schema.Schema.Type<typeof JsonSchema>
