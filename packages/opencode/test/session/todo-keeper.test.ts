import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { expect } from "bun:test"
import { Effect, Option } from "effect"
import { MessageID, PartID, SessionID } from "@/session/schema"
import type { Session } from "@/session/session"
import type { SessionPrompt } from "@/session/prompt"
import type { SessionStatus } from "@/session/status"
import { SessionTodoKeeper } from "@/session/todo-keeper"
import type { Todo } from "@/session/todo"
import { it } from "../lib/effect"

const sessionID = SessionID.make("ses_todo_keeper")
const providerID = ProviderV2.ID.make("test")
const modelID = ModelV2.ID.make("test-model")

const session = (overrides: Partial<Session.Info> = {}): Session.Info => ({
  id: sessionID,
  slug: "todo-keeper",
  projectID: ProjectV2.ID.make("prj_todo_keeper"),
  directory: "/tmp/todo-keeper",
  title: "todo keeper",
  version: "test",
  agent: "build",
  model: { id: modelID, providerID },
  time: { created: 1, updated: 1 },
  ...overrides,
})

const userMessage = (text: string, id = MessageID.ascending()): SessionV1.WithParts => ({
  info: {
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "build",
    model: { providerID, modelID },
  },
  parts: [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text }],
})

const assistantMessage = (
  input: { finish?: string; error?: boolean; text?: string; completed?: number } = {},
): SessionV1.WithParts => {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      sessionID,
      role: "assistant",
      parentID: MessageID.make("msg_parent"),
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      modelID,
      providerID,
      time: { created: Date.now(), completed: input.completed ?? Date.now() - SessionTodoKeeper.REMINDER_DELAY_MS - 1000 },
      finish: input.finish ?? "stop",
      ...(input.error
        ? { error: { name: "UnknownError", data: { message: "boom" } } as NonNullable<SessionV1.Assistant["error"]> }
        : {}),
    },
    parts: input.text ? [{ id: PartID.ascending(), sessionID, messageID: id, type: "text", text: input.text }] : [],
  }
}

const openTodo = (content: string, status = "pending"): Todo.Info => ({ content, status, priority: "high" })

const setup = (
  input: { todos?: Todo.Info[]; status?: SessionStatus.Info; session?: Partial<Session.Info> } = {},
) => {
  const messages: SessionV1.WithParts[] = []
  const calls: SessionPrompt.PromptInput[] = []
  const todos = input.todos ?? []
  const deps: SessionTodoKeeper.Deps = {
    sessions: {
      get: () => Effect.succeed(session(input.session)),
      findMessage: (_sessionID, predicate) => Effect.succeed(Option.fromUndefinedOr(messages.findLast(predicate))),
    },
    status: { get: () => Effect.succeed(input.status ?? { type: "idle" as const }) },
    todos: { get: () => Effect.succeed(todos) },
    // Delivering a reminder creates the synthetic user turn; the model answers
    // and ends its turn with a natural stop.
    prompt: (promptInput) =>
      Effect.sync(() => {
        calls.push(promptInput)
        messages.push(userMessage(promptInput.parts[0]?.type === "text" ? promptInput.parts[0].text : "", promptInput.messageID))
        messages.push(assistantMessage())
      }),
    stretches: new Map(),
  }
  return { deps, messages, calls }
}

const text = (input: SessionPrompt.PromptInput | undefined) => {
  const part = input?.parts[0]
  return part?.type === "text" ? part.text : ""
}

it.effect("reminds a root session that idles with open items", () =>
  Effect.gen(function* () {
    const harness = setup({ todos: [openTodo("write tests", "in_progress"), openTodo("ship the fix")] })
    harness.messages.push(userMessage("do the work"), assistantMessage())

    expect(yield* SessionTodoKeeper.check(harness.deps, sessionID)).toBe("retry")

    expect(harness.calls).toHaveLength(1)
    expect(text(harness.calls[0])).toContain("[todo-keeper]")
    expect(text(harness.calls[0])).toContain("- [in_progress] write tests")
    expect(text(harness.calls[0])).toContain("- [pending] ship the fix")
    expect(text(harness.calls[0])).toContain(SessionTodoKeeper.PAUSE)
    expect(harness.calls[0]?.agent).toBe("build")
    expect(harness.calls[0]?.model).toEqual({ providerID, modelID })
    expect(harness.calls[0]?.messageID).toBeDefined()
  }),
)

it.effect("stays quiet when every item is completed or cancelled", () =>
  Effect.gen(function* () {
    const harness = setup({ todos: [openTodo("done", "completed"), openTodo("dropped", "cancelled")] })
    harness.messages.push(userMessage("do the work"), assistantMessage())
    harness.deps.stretches.set(sessionID, { reminders: 1, messages: new Set() })

    expect(yield* SessionTodoKeeper.check(harness.deps, sessionID)).toBe("stop")

    expect(harness.calls).toHaveLength(0)
    expect(harness.deps.stretches.has(sessionID)).toBe(false)
  }),
)

it.effect("stays quiet unless the session is idle", () =>
  Effect.gen(function* () {
    const harness = setup({ todos: [openTodo("write tests")], status: { type: "sleeping", description: "wake", wake_at: 1 } })
    harness.messages.push(userMessage("do the work"), assistantMessage())

    expect(yield* SessionTodoKeeper.check(harness.deps, sessionID)).toBe("stop")

    expect(harness.calls).toHaveLength(0)
  }),
)

it.effect("stays quiet for subagent sessions", () =>
  Effect.gen(function* () {
    const harness = setup({
      todos: [openTodo("write tests")],
      session: { parentID: SessionID.make("ses_parent") },
    })
    harness.messages.push(userMessage("do the work"), assistantMessage())

    yield* SessionTodoKeeper.check(harness.deps, sessionID)

    expect(harness.calls).toHaveLength(0)
  }),
)

it.effect("stays quiet when the stop was not natural", () =>
  Effect.gen(function* () {
    const toolCalls = setup({ todos: [openTodo("write tests")] })
    toolCalls.messages.push(userMessage("do the work"), assistantMessage({ finish: "tool-calls" }))
    yield* SessionTodoKeeper.check(toolCalls.deps, sessionID)
    expect(toolCalls.calls).toHaveLength(0)

    const errored = setup({ todos: [openTodo("write tests")] })
    errored.messages.push(userMessage("do the work"), assistantMessage({ error: true }))
    yield* SessionTodoKeeper.check(errored.deps, sessionID)
    expect(errored.calls).toHaveLength(0)
  }),
)

it.effect("stays quiet while the last stop is fresher than the grace period", () =>
  Effect.gen(function* () {
    const harness = setup({ todos: [openTodo("write tests")] })
    harness.messages.push(userMessage("do the work"), assistantMessage({ completed: Date.now() }))

    expect(yield* SessionTodoKeeper.check(harness.deps, sessionID)).toBe("retry")

    expect(harness.calls).toHaveLength(0)
  }),
)

it.effect("bounds reminders per user message and resets on new user input", () =>
  Effect.gen(function* () {
    const harness = setup({ todos: [openTodo("write tests")] })
    harness.messages.push(userMessage("do the work"), assistantMessage())

    for (let sent = 1; sent <= SessionTodoKeeper.MAX_REMINDERS; sent++) {
      expect(yield* SessionTodoKeeper.check(harness.deps, sessionID)).toBe("retry")
      expect(harness.calls).toHaveLength(sent)
    }
    expect(yield* SessionTodoKeeper.check(harness.deps, sessionID)).toBe("stop")
    expect(harness.calls).toHaveLength(SessionTodoKeeper.MAX_REMINDERS)

    harness.messages.push(userMessage("try again"), assistantMessage())
    yield* SessionTodoKeeper.check(harness.deps, sessionID)
    expect(harness.calls).toHaveLength(SessionTodoKeeper.MAX_REMINDERS + 1)
  }),
)

it.effect("a paused reply stands the check down until the user writes again", () =>
  Effect.gen(function* () {
    const harness = setup({ todos: [openTodo("write tests")] })
    harness.messages.push(userMessage("do the work"), assistantMessage())
    yield* SessionTodoKeeper.check(harness.deps, sessionID)
    expect(harness.calls).toHaveLength(1)

    harness.messages.push(assistantMessage({ text: `${SessionTodoKeeper.PAUSE} waiting for the user` }))
    expect(yield* SessionTodoKeeper.check(harness.deps, sessionID)).toBe("stop")
    yield* SessionTodoKeeper.check(harness.deps, sessionID)
    expect(harness.calls).toHaveLength(1)

    harness.messages.push(userMessage("go ahead"), assistantMessage())
    yield* SessionTodoKeeper.check(harness.deps, sessionID)
    expect(harness.calls).toHaveLength(2)
  }),
)

it.effect("a newer user turn resets the reminder allowance", () =>
  Effect.gen(function* () {
    const harness = setup({ todos: [openTodo("write tests")] })
    harness.messages.push(userMessage("do the work"), assistantMessage())
    yield* SessionTodoKeeper.check(harness.deps, sessionID)
    expect(harness.deps.stretches.get(sessionID)?.reminders).toBe(1)

    harness.messages.push(userMessage("unrelated question"), assistantMessage())
    yield* SessionTodoKeeper.check(harness.deps, sessionID)
    expect(harness.deps.stretches.get(sessionID)?.reminders).toBe(1)
    expect(harness.calls).toHaveLength(2)
  }),
)
