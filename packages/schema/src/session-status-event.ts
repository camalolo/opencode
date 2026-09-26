export * as SessionStatusEvent from "./session-status-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { NonNegativeInt } from "./schema"
import { SessionID } from "./session-id"

export const Info = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("idle"),
  }),
  Schema.Struct({
    type: Schema.Literal("retry"),
    attempt: NonNegativeInt,
    message: Schema.String,
    action: optional(
      Schema.Struct({
        reason: Schema.String,
        provider: Schema.String,
        title: Schema.String,
        message: Schema.String,
        label: Schema.String,
        link: optional(Schema.String),
      }),
    ),
    next: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("busy"),
  }),
  Schema.Struct({
    type: Schema.Literal("sleeping"),
    description: Schema.String.annotate({
      description: "What the session is waiting for, as set by the sleep_until tool",
    }),
    wake_at: NonNegativeInt.annotate({ description: "Epoch ms when the trigger times out" }),
  }),
]).annotate({ identifier: "SessionStatus" })
export type Info = Schema.Schema.Type<typeof Info>

export const Status = Event.define({
  type: "session.status",
  schema: {
    sessionID: SessionID,
    status: Info,
  },
})

// deprecated
export const Idle = Event.define({
  type: "session.idle",
  schema: {
    sessionID: SessionID,
  },
})

export const Definitions = Event.inventory(Status, Idle)
