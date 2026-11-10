import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Task } from "@opencode-ai/schema/task"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/schema/schema"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError, TaskNotFoundError } from "../errors"
import { Location } from "@opencode-ai/schema/location"
import { LocationQuery, locationQueryOpenApi } from "./location"

const NullableString = Schema.NullOr(Schema.String)
const NullableNumber = Schema.NullOr(Schema.Number)

const TaskListQuery = Schema.Struct({
  ...LocationQuery.fields,
  all: Schema.optional(
    Schema.Boolean.annotate({
      description: "List every task across directories instead of only the requested location",
    }),
  ),
})

const TaskRecentRunsQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of runs to return. Defaults to the newest 50 runs.",
  }),
})

const RunWithTask = Schema.Struct({
  task: Task.Info,
  run: Task.Run,
}).annotate({ identifier: "Task.RunWithTask" })

const TaskValidatePayload = Schema.Struct({
  cron: Schema.String,
  timezone: Schema.optional(NullableString),
})

const TaskValidateSuccess = Schema.Struct({
  next: Schema.Array(NonNegativeInt).annotate({
    description: "Epoch ms of the next fire times; empty when the schedule has no future occurrence",
  }),
}).annotate({ identifier: "Task.ValidateSuccess" })

const TaskPayloadFields = {
  name: Schema.String,
  description: Schema.optional(NullableString),
  cron: Schema.String,
  timezone: Schema.optional(NullableString),
  agent: Schema.optional(Agent.ID),
  model: Schema.optional(Model.Ref),
  prompt: Schema.String,
  enabled: Schema.optional(Schema.Boolean),
  runTimeoutMs: Schema.optional(NullableNumber),
  retainRuns: Schema.optional(NullableNumber),
}

const TaskUpdatePayloadFields = {
  name: Schema.optional(Schema.String),
  description: Schema.optional(NullableString),
  cron: Schema.optional(Schema.String),
  timezone: Schema.optional(NullableString),
  agent: Schema.optional(Schema.NullOr(Agent.ID)),
  model: Schema.optional(Schema.NullOr(Model.Ref)),
  prompt: Schema.optional(Schema.String),
  enabled: Schema.optional(Schema.Boolean),
  runTimeoutMs: Schema.optional(NullableNumber),
  retainRuns: Schema.optional(NullableNumber),
}

export const TaskGroup = HttpApiGroup.make("server.task")
  .add(
    HttpApiEndpoint.get("task.list", "/api/task", {
      query: TaskListQuery,
      success: Location.response(Schema.Array(Task.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.task.list",
          summary: "List scheduled tasks",
          description:
            "Retrieve scheduled tasks bound to the requested location, or every task across directories with all=true.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("task.create", "/api/task", {
      query: LocationQuery,
      payload: Schema.Struct(TaskPayloadFields),
      success: Location.response(Task.Info),
      error: [ConflictError, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.task.create",
          summary: "Create scheduled task",
          description: "Create a scheduled task bound to the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("task.get", "/api/task/:taskID", {
      params: { taskID: Task.ID },
      query: LocationQuery,
      success: Location.response(Task.Info),
      error: TaskNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.task.get",
          summary: "Get scheduled task",
          description: "Retrieve a scheduled task by ID.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.patch("task.update", "/api/task/:taskID", {
      params: { taskID: Task.ID },
      query: LocationQuery,
      payload: Schema.Struct(TaskUpdatePayloadFields),
      success: Location.response(Task.Info),
      error: [TaskNotFoundError, ConflictError, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.task.update",
          summary: "Update scheduled task",
          description: "Update a scheduled task; omitted fields keep their current value, null clears them.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("task.remove", "/api/task/:taskID", {
      params: { taskID: Task.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
      error: TaskNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.task.remove",
          summary: "Remove scheduled task",
          description: "Delete a scheduled task and its run history.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("task.trigger", "/api/task/:taskID/trigger", {
      params: { taskID: Task.ID },
      query: LocationQuery,
      success: Location.response(Task.Run),
      error: [TaskNotFoundError, ConflictError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.task.trigger",
          summary: "Trigger scheduled task",
          description: "Queue an immediate run of a scheduled task.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("task.listRuns", "/api/task/:taskID/run", {
      params: { taskID: Task.ID },
      query: LocationQuery,
      success: Location.response(Schema.Array(Task.Run)),
      error: TaskNotFoundError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.task.listRuns",
          summary: "List scheduled task runs",
          description: "Retrieve the run history of a scheduled task, newest first.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("task.listRunsRecent", "/api/task-runs", {
      query: TaskRecentRunsQuery,
      success: Location.response(Schema.Array(RunWithTask)),
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.task.listRunsRecent",
          summary: "List recent scheduled task runs",
          description: "Retrieve the newest runs across every scheduled task, newest first.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("task.validate", "/api/task/validate", {
      payload: TaskValidatePayload,
      success: Location.response(TaskValidateSuccess),
      error: InvalidRequestError,
    })
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.task.validate",
          summary: "Validate a task schedule",
          description: "Check a cron expression and timezone; returns the next fire times in epoch ms.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "scheduled tasks",
      description: "Scheduled autonomous session runs.",
    }),
  )
