import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"
import type { Info } from "./session"

const COMPACTION_BUFFER = 20_000

export function usable(input: {
  cfg: ConfigV1.Info
  model: Provider.Model
  session?: Info
  outputTokenMax?: number
}) {
  const context = input.model.limit.context
  if (context === 0) return 0

  // A threshold (per session, else global) is a direct fraction of the context
  // window and takes precedence over the reserved-token buffer.
  const threshold = input.session?.compactionThreshold ?? input.cfg.compaction?.threshold ?? undefined
  if (threshold) return Math.round((input.model.limit.input ?? context) * threshold)

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  session?: Info
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= usable(input)
}
