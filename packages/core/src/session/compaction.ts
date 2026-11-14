export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@opencode-ai/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { Token } from "../util/token"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`
const SUMMARY_UPDATE_INSTRUCTIONS = `The <prior-summary> summarizes everything that happened before the <conversation>. Construct a new summary that combines both. The <prior-summary> is discarded after this: anything you do not carry into the new summary is lost.

When combining:
- Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary> even when the <conversation> does not mention them. Drop only what is finished and no longer needed.
- The <conversation> is more recent than the <prior-summary>. Where they conflict, the conversation wins: state the corrected fact and drop the old claim.
- Add new progress, decisions, constraints, and context from the conversation.
- Move completed work from "Active" to "Completed".
- If a blocker has been resolved, update the summary to reflect that while keeping any details still needed to continue the work.
- Update "Objective" and "Next Move" to reflect the current work state.`
const SUMMARY_RECONCILE_INSTRUCTIONS = `The <recent-context> section contains the newest turns of the conversation, kept verbatim in the live context after this summary. Reconcile the summary against it even though it is not part of the <conversation>: work shown as finished there moves to "Completed", and "Active" and "Next Move" must reflect its latest state instead of proposing work it already did.`

type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
  readonly threshold?: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  // Per-session override of the configured compaction threshold (fraction of
  // the model context window), read from the Session record when present.
  readonly threshold?: number
}

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      threshold: current.threshold === null ? undefined : (current.threshold ?? result.threshold),
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS },
  )
}

const select = (entries: readonly Entry[], tokens: number) => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => serialize(entry.message))
    .filter(Boolean)
  if (conversation.length === 0) return
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index])
    if (next > tokens) break
    total = next
    split = index
  }
  return {
    head: conversation.slice(0, split),
    recent: conversation.slice(split),
  }
}

export const buildPrompt = (input: {
  readonly previousSummary?: string
  readonly context: readonly string[]
  readonly recent?: string
}) => {
  const conversation = `Here is the conversation so far:\n\n<conversation>\n${input.context.join("\n\n")}\n</conversation>`
  const recent = input.recent
    ? `\n\n${SUMMARY_RECONCILE_INSTRUCTIONS}\n\nHere are the newest turns:\n\n<recent-context>\n${input.recent}\n</recent-context>`
    : ""
  if (!input.previousSummary)
    return [
      conversation,
      "Create a new anchored summary from the conversation history in the <conversation> tags above so another coding agent can continue the work.",
      SUMMARY_TEMPLATE,
    ].join("\n\n") + recent
  return [
    conversation,
    `Here is the summary of the conversation before the <conversation> above:\n\n<prior-summary>\n${input.previousSummary}\n</prior-summary>`,
    SUMMARY_UPDATE_INSTRUCTIONS,
    SUMMARY_TEMPLATE,
  ].join("\n\n") + recent
}

// Split serialized messages into chunks that each fit `budget` tokens. Returns
// undefined when everything already fits in a single chunk, so folding has
// nothing to do.
const foldChunks = (messages: readonly string[], budget: number) => {
  if (budget <= 0) return undefined
  const chunks: string[][] = []
  let current: string[] = []
  let total = 0
  for (const message of messages) {
    const size = Token.estimate(message)
    if (current.length > 0 && total + size > budget) {
      chunks.push(current)
      current = []
      total = 0
    }
    current.push(message)
    total += size
  }
  if (current.length > 0) chunks.push(current)
  return chunks.length >= 2 ? chunks : undefined
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const summarize = (input: { prompt: string; maxTokens: number; model: Model }) =>
    Effect.gen(function* () {
      const chunks: string[] = []
      let failed = false
      const summarized = yield* dependencies.llm
        .stream(
          LLM.request({
            model: input.model,
            messages: [Message.user(input.prompt)],
            tools: [],
            generation: { maxTokens: input.maxTokens },
          }),
        )
        .pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.providerError(event)) failed = true
            if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
            return Effect.void
          }),
          Effect.as(true),
          Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
        )
      const text = chunks.join("")
      return summarized && !failed && text.trim() ? text : undefined
    })

  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (input: Input) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const selected = select(input.entries, config.tokens)
    const previousSummary = input.entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const recent = selected.recent.join("\n\n")
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    const contextForSummary = (prompt: string) => Token.estimate(prompt) <= context - summaryOutput

    const singlePrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", ...selected.head].filter(
        Boolean,
      ),
      recent,
    })

    // Publish the started marker once for the whole compaction; fold steps are
    // invisible to consumers and only the final summary is persisted.
    const publishSummary = (summary: string) =>
      Effect.gen(function* () {
        const messageID = SessionMessage.ID.create()
        yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
          sessionID: input.sessionID,
          messageID,
          timestamp: yield* DateTime.now,
          reason: "auto",
        })
        yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
          sessionID: input.sessionID,
          messageID,
          timestamp: yield* DateTime.now,
          reason: "auto",
          text: summary,
          recent,
        })
        return true
      })

    if (contextForSummary(singlePrompt)) {
      const summary = yield* summarize({ prompt: singlePrompt, maxTokens: summaryOutput, model: input.model })
      if (!summary) return false
      return yield* publishSummary(summary)
    }

    // The full history does not fit the summarizer's window: fold it forward in
    // chunks (oldest first), each fold combining the running summary with the
    // next chunk, and reconcile the final fold against the retained tail.
    // Reserve the generated-text bound for both the running summary and the
    // final output; overhead is measured on the largest prompt branch (update
    // instructions + recent section).
    const promptBudget = context - summaryOutput
    const overhead = Token.estimate(buildPrompt({ previousSummary: "", context: [], recent }))
    const chunks = foldChunks(selected.head, promptBudget - overhead - summaryOutput)
    const lastChunk = chunks?.at(-1)
    if (!chunks || !lastChunk) return false

    const priorSummary = previousSummary?.type === "compaction" ? previousSummary.summary : undefined
    let running = priorSummary
    for (const chunk of chunks.slice(0, -1)) {
      running = yield* summarize({
        prompt: buildPrompt({ previousSummary: running, context: chunk }),
        maxTokens: summaryOutput,
        model: input.model,
      })
      if (!running) return false
    }
    const finalPrompt = buildPrompt({ previousSummary: running, context: lastChunk, recent })
    if (!contextForSummary(finalPrompt)) return false
    const summary = yield* summarize({ prompt: finalPrompt, maxTokens: summaryOutput, model: input.model })
    if (!summary) return false
    return yield* publishSummary(summary)
  })

  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const threshold = input.threshold ?? config.threshold
    // A threshold is a direct fraction of the context window and replaces the
    // reserved-buffer math when set.
    const limit = threshold ? Math.round(context * threshold) : context - Math.max(output, config.buffer)
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <= limit
    )
      return false
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
