import { ScheduledTask } from "@opencode-ai/core/task/task"
import { TaskSchedule } from "@opencode-ai/core/task/schedule"
import { ConflictError, InvalidRequestError, TaskNotFoundError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const TaskHandler = HttpApiBuilder.group(Api, "server.task", (handlers) =>
  handlers
    .handle("task.list", (ctx) =>
      response(ScheduledTask.Service.use((tasks) => (ctx.query.all ? tasks.listAll() : tasks.list()))),
    )
    .handle(
      "task.create",
      (ctx) =>
        response(
          ScheduledTask.Service.use((tasks) => tasks.create(ctx.payload)).pipe(
            Effect.catchTag("Task.InvalidScheduleError", (error) =>
              Effect.fail(new InvalidRequestError({ message: error.message, kind: "invalid_schedule" })),
            ),
            Effect.catchTag("Task.DuplicateError", (error) =>
              Effect.fail(
                new ConflictError({
                  message: `A task named "${error.name}" already exists in this directory`,
                  resource: "task",
                }),
              ),
            ),
          ),
        ),
    )
    .handle(
      "task.get",
      (ctx) =>
        response(
          ScheduledTask.Service.use((tasks) => tasks.get(ctx.params.taskID)).pipe(
            Effect.catchTag("Task.NotFoundError", (error) => Effect.fail(notFound(error.taskID))),
          ),
        ),
    )
    .handle(
      "task.update",
      (ctx) =>
        response(
          ScheduledTask.Service.use((tasks) => tasks.update(ctx.params.taskID, ctx.payload)).pipe(
            Effect.catchTag("Task.NotFoundError", (error) => Effect.fail(notFound(error.taskID))),
            Effect.catchTag("Task.InvalidScheduleError", (error) =>
              Effect.fail(new InvalidRequestError({ message: error.message, kind: "invalid_schedule" })),
            ),
            Effect.catchTag("Task.DuplicateError", (error) =>
              Effect.fail(
                new ConflictError({
                  message: `A task named "${error.name}" already exists in this directory`,
                  resource: "task",
                }),
              ),
            ),
          ),
        ),
    )
    .handle(
      "task.remove",
      (ctx) =>
        Effect.gen(function* () {
          yield* ScheduledTask.Service.use((tasks) => tasks.remove(ctx.params.taskID)).pipe(
            Effect.catchTag("Task.NotFoundError", (error) => Effect.fail(notFound(error.taskID))),
          )
          return HttpApiSchema.NoContent.make()
        }),
    )
    .handle(
      "task.trigger",
      (ctx) =>
        response(
          ScheduledTask.Service.use((tasks) => tasks.trigger(ctx.params.taskID)).pipe(
            Effect.catchTag("Task.NotFoundError", (error) => Effect.fail(notFound(error.taskID))),
            Effect.catchTag("Task.ActiveRunError", () =>
              Effect.fail(
                new ConflictError({ message: "A run is already pending or running for this task", resource: "task" }),
              ),
            ),
          ),
        ),
    )
    .handle(
      "task.listRuns",
      (ctx) =>
        response(
          ScheduledTask.Service.use((tasks) => tasks.runs(ctx.params.taskID)).pipe(
            Effect.catchTag("Task.NotFoundError", (error) => Effect.fail(notFound(error.taskID))),
          ),
        ),
    )
    .handle("task.listRunsRecent", (ctx) =>
      response(ScheduledTask.Service.use((tasks) => tasks.recentRuns(ctx.query.limit ?? 50))),
    )
    .handle("task.validate", (ctx) => {
      const timezone = ctx.payload.timezone ?? undefined
      const invalid = TaskSchedule.validate({ cron: ctx.payload.cron, timezone })
      if (invalid) {
        return Effect.fail(new InvalidRequestError({ message: invalid.message, kind: "invalid_schedule" }))
      }
      const next: Array<number> = []
      let after = Date.now()
      for (let i = 0; i < 5; i++) {
        const fire = TaskSchedule.nextAfter({ cron: ctx.payload.cron, timezone, after })
        next.push(fire)
        after = fire
      }
      return response(Effect.succeed({ next }))
    }),
)

function notFound(taskID: string) {
  return new TaskNotFoundError({ taskID, message: `Scheduled task not found: ${taskID}` })
}
