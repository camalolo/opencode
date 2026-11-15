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
    next_check_at: optional(
      NonNegativeInt.annotate({ description: "Epoch ms when the next condition check is due; absent when unknown" }),
    ),
    interval_ms: optional(
      NonNegativeInt.annotate({
        description: "Milliseconds between condition checks; clients derive heartbeat staleness from it",
      }),
    ),
    loop_forever: optional(
      Schema.Boolean.annotate({
        description:
          "loop_forever is armed: when a turn ends without a new sleep_until, this exact watcher re-arms itself",
      }),
    ),
    broken_checks: optional(
      NonNegativeInt.annotate({
        description: "Broken (crashed) checks so far; the trigger disarms itself when it reaches broken_check_limit",
      }),
    ),
    broken_check_limit: optional(
      NonNegativeInt.annotate({
        description: "Broken-check budget; reaching it disarms the trigger and wakes the session",
      }),
    ),
    check_kind: optional(
      Schema.String.annotate({
        description:
          "The armed check type (output_marker, file_contains, process_exited, url_status, file_quiet, custom); absent for legacy triggers armed before typed checks",
      }),
    ),
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
