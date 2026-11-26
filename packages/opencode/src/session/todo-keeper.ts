// todo-keeper — a reminder for agents that stop with an open todo list.
//
// The todo list is the session's goal: agents create one for non-trivial work
// and are expected to reconcile it before stopping. Distracted agents stop
// early anyway, freezing the list at pending/in_progress. This keeper watches
// session idleness: when a root session goes idle with open items, it waits a
// grace period (the user may be answering) and then, still idle, appends a
// synthetic reminder that either continues the next item or reconciles the
// list. A real user message grants a fresh allowance; an agent that replies
// with the pause marker (waiting on the user, or told to wait) stands the
// check down until the user writes again. A clean list is the completion
// signal, so no separate goal state is needed.
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { Duration, Effect, Fiber, Layer, Option, Scope, Stream } from "effect"
import { InstanceStore } from "@/project/instance-store"
import { MessageID, SessionID } from "./schema"
import { Session } from "./session"
import { SessionPrompt } from "./prompt"
import { SessionStatus } from "./status"
import { Todo } from "./todo"

const MARKER = "[todo-keeper]"
/** Reply marker: the agent is deliberately waiting on the user. */
export const PAUSE = "[paused]"
/** Grace period before the first reminder; the user often answers a stop. */
export const REMINDER_DELAY_MS = Number(process.env.OPENCODE_TODO_REMINDER_DELAY_MS ?? 10 * 60 * 1000)
/** Reminders per real user message; a new user turn grants a fresh allowance. */
export const MAX_REMINDERS = Number(process.env.OPENCODE_TODO_REMINDER_MAX ?? 3)
/** Keep the reminder readable; the model can read the full list with todowrite. */
const MAX_LISTED = 8

const isOpen = (todo: Todo.Info) => todo.status === "pending" || todo.status === "in_progress"

/** Bookkeeping for one real user message: which reminders this keeper wrote in
 * response to it, and how many the allowance has consumed. */
export interface Stretch {
  reminders: number
  messages: Set<string>
}

export interface Deps {
  readonly sessions: {
    readonly get: (sessionID: SessionID) => Effect.Effect<Session.Info, unknown>
    readonly findMessage: (
      sessionID: SessionID,
      predicate: (message: SessionV1.WithParts) => boolean,
    ) => Effect.Effect<Option.Option<SessionV1.WithParts>, unknown>
  }
  readonly status: { readonly get: (sessionID: SessionID) => Effect.Effect<SessionStatus.Info> }
  readonly todos: { readonly get: (sessionID: SessionID) => Effect.Effect<ReadonlyArray<Todo.Info>> }
  readonly prompt: (input: SessionPrompt.PromptInput) => Effect.Effect<unknown, unknown>
  readonly stretches: Map<SessionID, Stretch>
}

const reminderText = (open: ReadonlyArray<Todo.Info>) => {
  const items = open.slice(0, MAX_LISTED).map((todo) => `- [${todo.status}] ${todo.content}`)
  if (open.length > items.length) items.push(`- ...and ${open.length - items.length} more`)
  return [
    `${MARKER} You stopped while the todo list still has open items:`,
    ...items,
    "",
    `Continue with the next open item now, or reconcile the list with todowrite: mark finished items "completed" and cancel items you will not do.`,
    `If you are waiting on the user (a question or a pause), reply with exactly ${PAUSE} and a one-line reason — reminders then stop until the user writes again.`,
  ].join("\n")
}

/**
 * One reminder check for an idle session. Re-verifies everything at fire time
 * because the grace period may have been overtaken by a new user turn, a wake,
 * a deliberate sleep, a cancel, or a provider error.
 *
 * "retry" keeps the reminder chain alive: the round either sent a reminder or
 * found the stop fresher than the grace period, so another check is due. Every
 * other outcome stops the chain and waits for the next idle to schedule one.
 */
export type Outcome = "stop" | "retry"

export const check = Effect.fn("SessionTodoKeeper.check")(function* (deps: Deps, sessionID: SessionID) {
  if ((yield* deps.status.get(sessionID)).type !== "idle") return "stop" as const

  const open = (yield* deps.todos.get(sessionID)).filter(isOpen)
  if (open.length === 0) {
    deps.stretches.delete(sessionID)
    return "stop" as const
  }

  const session = yield* deps.sessions.get(sessionID)
  // Subagents are driven by their parent's task call; a reminder here would run
  // an orphan turn whose output nothing reads.
  if (session.parentID) return "stop" as const

  const lastUser = yield* deps.sessions.findMessage(sessionID, (message) => message.info.role === "user")
  if (Option.isNone(lastUser)) return "stop" as const
  // A user message this keeper did not write is new intent: fresh allowance.
  const previous = deps.stretches.get(sessionID)
  const stretch =
    previous && previous.messages.has(lastUser.value.info.id) ? previous : { reminders: 0, messages: new Set<string>() }
  deps.stretches.set(sessionID, stretch)
  if (stretch.reminders >= MAX_REMINDERS) return "stop" as const

  const last = yield* deps.sessions.findMessage(sessionID, (message) => message.info.role === "assistant")
  if (Option.isNone(last)) return "stop" as const
  const info = last.value.info
  // Only a natural stop: aborts, provider errors and tool-call hand-offs are
  // live turns, not a distracted stop.
  if (info.role !== "assistant" || info.error !== undefined || info.finish !== "stop") return "stop" as const
  // The grace period is enforced here, not by the timer: a turn that ended
  // after this check was scheduled makes the session fresh again.
  if (Date.now() - (info.time.completed ?? info.time.created) < REMINDER_DELAY_MS) return "retry" as const
  if (last.value.parts.some((part) => part.type === "text" && part.text.includes(PAUSE))) {
    stretch.reminders = MAX_REMINDERS
    return "stop" as const
  }

  // Record the reminder before delivering: a failed delivery still consumes
  // the allowance, and a message that never landed simply looks like a new
  // user turn on the next check and resets the stretch.
  const messageID = MessageID.ascending()
  stretch.reminders += 1
  stretch.messages.add(messageID)
  yield* Effect.logInfo("todo reminder", {
    "session.id": sessionID,
    "todo.open": open.length,
    "todo.reminder": stretch.reminders,
  })
  yield* deps.prompt({
    sessionID,
    messageID,
    parts: [{ type: "text", text: reminderText(open), synthetic: true }],
    ...(session.agent ? { agent: session.agent } : {}),
    ...(session.model
      ? {
          model: { providerID: session.model.providerID, modelID: session.model.id },
          ...(session.model.variant && session.model.variant !== "default" ? { variant: session.model.variant } : {}),
        }
      : {}),
  })
  return "retry" as const
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const instances = yield* InstanceStore.Service
    const sessions = yield* Session.Service
    const status = yield* SessionStatus.Service
    const todos = yield* Todo.Service
    const prompt = yield* SessionPrompt.Service
    const scope = yield* Scope.Scope

    const stretches = new Map<SessionID, Stretch>()
    // One reminder chain per session. Idle events while a chain sleeps (the
    // user's own turns, or the chain's reminder turn) do not start a second
    // one; the chain re-verifies state itself on every round.
    const pending = new Map<SessionID, Fiber.Fiber<void>>()
    const deps = { sessions, status, todos, prompt: prompt.prompt, stretches }

    const chain = (sessionID: SessionID, directory: string) =>
      Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(Duration.millis(REMINDER_DELAY_MS))
          if ((yield* instances.provide({ directory }, check(deps, sessionID))) === "stop") return
        }
      })

    const schedule = (sessionID: SessionID, directory: string) =>
      Effect.gen(function* () {
        if (pending.has(sessionID)) return
        const fiber = yield* chain(sessionID, directory).pipe(
          Effect.ensuring(Effect.sync(() => pending.delete(sessionID))),
          Effect.catchCause((cause) => Effect.logWarning("todo reminder failed", { "session.id": sessionID, cause })),
          Effect.forkIn(scope),
        )
        pending.set(sessionID, fiber)
      })

    yield* events.subscribe(SessionStatusEvent.Status).pipe(
      Stream.runForEach((payload) => {
        if (payload.data.status.type !== "idle") return Effect.void
        const directory = payload.location?.directory
        if (!directory) return Effect.void
        return schedule(payload.data.sessionID, directory)
      }),
      Effect.catchCause((cause) => Effect.logError("todo keeper subscription failed", { cause })),
      Effect.forkScoped,
    )
  }),
)

export const node = makeGlobalNode({
  name: "session-todo-keeper",
  layer,
  deps: [EventV2.node, InstanceStore.node, Session.node, SessionStatus.node, Todo.node, SessionPrompt.node],
})

export * as SessionTodoKeeper from "./todo-keeper"
