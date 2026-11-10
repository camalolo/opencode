export * as Task from "./task"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { Agent } from "./agent"
import { Model } from "./model"
import { AbsolutePath, NonNegativeInt, optional, statics } from "./schema"
import { SessionID } from "./session-id"

export const ID = Schema.String.check(Schema.isStartsWith("task_")).pipe(
  Schema.brand("Task.ID"),
  statics((schema) => ({ create: () => schema.make("task_" + ascending()) })),
)
export type ID = typeof ID.Type

export const RunID = Schema.String.check(Schema.isStartsWith("run_")).pipe(
  Schema.brand("Task.RunID"),
  statics((schema) => ({ create: () => schema.make("run_" + ascending()) })),
)
export type RunID = typeof RunID.Type

export const RunStatus = Schema.Literals(["pending", "running", "completed", "failed", "skipped", "cancelled"])
export type RunStatus = typeof RunStatus.Type

export const RunTrigger = Schema.Literals(["schedule", "manual"])
export type RunTrigger = typeof RunTrigger.Type

export const RunReason = Schema.Literals(["error", "timeout", "cancelled", "interrupted"]).annotate({
  description: "Why a run did not succeed; absent for successful runs",
})
export type RunReason = typeof RunReason.Type

export const Info = Schema.Struct({
  id: ID,
  directory: AbsolutePath.annotate({ description: "Absolute working directory the scheduled session runs in" }),
  name: Schema.String.annotate({ description: "Unique task name within its directory" }),
  description: optional(Schema.String),
  cron: Schema.String.annotate({ description: "Five-field cron expression in the task timezone" }),
  timezone: optional(Schema.String.annotate({ description: "IANA timezone for the cron expression; defaults to the server timezone" })),
  agent: optional(Agent.ID.annotate({ description: "Agent used for scheduled sessions; defaults to the configured default agent" })),
  model: optional(Model.Ref.annotate({ description: "Model used for scheduled sessions; defaults to the configured default model" })),
  prompt: Schema.String.annotate({ description: "Prompt text admitted into each scheduled session" }),
  enabled: Schema.Boolean,
  runTimeoutMs: optional(NonNegativeInt.annotate({ description: "Interrupt and fail runs that exceed this duration" })),
  retainRuns: optional(NonNegativeInt.annotate({ description: "Maximum run history rows kept per task; older runs are pruned" })),
  nextRunAt: optional(NonNegativeInt.annotate({ description: "Epoch ms of the next scheduled fire; absent while disabled" })),
  timeCreated: NonNegativeInt,
  timeUpdated: NonNegativeInt,
}).annotate({ identifier: "Task.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

export const Run = Schema.Struct({
  id: RunID,
  taskID: ID,
  sessionID: optional(SessionID.annotate({ description: "Session created for this run; absent until delivery starts" })),
  status: RunStatus,
  trigger: RunTrigger,
  reason: optional(RunReason),
  scheduledAt: NonNegativeInt.annotate({ description: "Epoch ms of the schedule slot this run fulfills" }),
  timeStarted: optional(NonNegativeInt),
  timeCompleted: optional(NonNegativeInt),
  error: optional(Schema.String),
}).annotate({ identifier: "Task.Run" })
export interface Run extends Schema.Schema.Type<typeof Run> {}

const Updated = define({
  type: "task.updated",
  schema: {
    task: Info,
  },
})

const RunUpdated = define({
  type: "task.run.updated",
  schema: {
    run: Run,
  },
})

export const Event = { Updated, RunUpdated, Definitions: inventory(Updated, RunUpdated) }
