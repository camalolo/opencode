import { Effect } from "effect"
import path from "path"
import type { Argv } from "yargs"
import { Database } from "@opencode-ai/core/database/database"
import { ScheduledTask } from "@opencode-ai/core/task/task"
import { TaskSchedule } from "@opencode-ai/core/task/schedule"
import { Task } from "@opencode-ai/schema/task"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Agent } from "@opencode-ai/schema/agent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { cmd } from "./cmd"

const RUN_STATUS_STYLE: Record<Task.RunStatus, string> = {
  pending: UI.Style.TEXT_DIM,
  running: UI.Style.TEXT_INFO_BOLD,
  completed: UI.Style.TEXT_SUCCESS_BOLD,
  failed: UI.Style.TEXT_DANGER_BOLD,
  skipped: UI.Style.TEXT_DIM,
  cancelled: UI.Style.TEXT_DIM,
}

function formatTime(ms: number | undefined): string {
  if (ms === undefined) return "-"
  return new Date(ms).toLocaleString()
}

function nextRun(task: ScheduledTask.Info): string {
  if (!task.enabled) return "disabled"
  if (task.nextRunAt === undefined) return "-"
  return `${formatTime(task.nextRunAt)} (${task.cron})`
}

interface EditFields {
  readonly description?: string | null
  readonly agent?: string | null
  readonly model?: Model.Ref | null
  readonly runTimeoutMs?: number | null
  readonly retainRuns?: number | null
  readonly enabled?: boolean
}

const editFields = Effect.fn("Cli.task.editFields")(function* (options: {
  readonly description?: string
  readonly agent?: string
  readonly model?: string
  readonly "timeout-ms"?: number
  readonly retain?: number
  readonly enabled?: boolean
}) {
  let model: Model.Ref | undefined
  if (options.model !== undefined) {
    const [providerID, id] = options.model.split("/")
    if (!providerID || !id) return yield* fail(`Invalid --model "${options.model}", expected provider/model`)
    model = { providerID: Provider.ID.make(providerID), id: Model.ID.make(id) }
  }
  return {
    ...(options.description === undefined ? {} : { description: options.description }),
    ...(options.agent === undefined ? {} : { agent: Agent.ID.make(options.agent) }),
    ...(model === undefined ? {} : { model }),
    ...(options["timeout-ms"] === undefined ? {} : { runTimeoutMs: options["timeout-ms"] }),
    ...(options.retain === undefined ? {} : { retainRuns: options.retain }),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
  }
})

/** Resolves a task by ID, or by name within a directory. */
const resolve = Effect.fn("Cli.task.resolve")(function* (directory: string, nameOrID: string) {
  const { db } = yield* Database.Service
  const byID = nameOrID.startsWith("task_") ? yield* ScheduledTask.byID(db, Task.ID.make(nameOrID)) : undefined
  if (byID) return byID
  const tasks = yield* ScheduledTask.byDirectory(db, directory)
  const byName = tasks.find((task) => task.name === nameOrID)
  if (byName) return byName
  return yield* fail(`No scheduled task "${nameOrID}" in ${directory}`)
})

function printTask(task: ScheduledTask.Info) {
  UI.println(
    `  ${UI.Style.TEXT_NORMAL_BOLD}${task.name}${UI.Style.TEXT_NORMAL} ${UI.Style.TEXT_DIM}${task.id}${UI.Style.TEXT_NORMAL}`,
  )
  UI.println(`    ${task.description ?? ""}`)
  UI.println(`    schedule: ${task.cron}${task.timezone ? ` (${task.timezone})` : ""}  next: ${nextRun(task)}`)
  UI.println(
    `    directory: ${task.directory}  agent: ${task.agent ?? "default"}  model: ${
      task.model ? `${task.model.providerID}/${task.model.id}` : "default"
    }`,
  )
  UI.println(`    timeout: ${task.runTimeoutMs === undefined ? "-" : `${task.runTimeoutMs}ms`}  retain: ${task.retainRuns}`)
  UI.println(`    prompt: ${task.prompt.replace(/\s+/g, " ").slice(0, 120)}${task.prompt.length > 120 ? "…" : ""}`)
}

function printRun(run: ScheduledTask.Run) {
  const style = RUN_STATUS_STYLE[run.status]
  UI.println(
    `  ${style}${run.status.padEnd(10)}${UI.Style.TEXT_NORMAL} ${formatTime(run.scheduledAt)}  ${run.trigger.padEnd(8)} ${
      run.sessionID ?? "-"
    }${run.error ? `  ${UI.Style.TEXT_DANGER}${run.error}${UI.Style.TEXT_NORMAL}` : ""}`,
  )
}

const sharedOptions = (yargs: Argv) =>
  yargs.options({
    directory: { type: "string", describe: "task directory (defaults to cwd)" },
    cron: { type: "string", describe: "five-field cron expression" },
    tz: { type: "string", describe: "IANA timezone for the cron expression" },
    agent: { type: "string", describe: "agent used for scheduled sessions" },
    model: { type: "string", describe: "model as provider/model" },
    description: { type: "string", describe: "task description" },
    "timeout-ms": { type: "number", describe: "interrupt runs that exceed this duration" },
    retain: { type: "number", describe: "run history rows to keep (default 20)" },
  })

export const TaskAddCommand = effectCmd({
  command: "add <name>",
  describe: "create a scheduled task",
  instance: false,
  builder: (yargs) =>
    sharedOptions(yargs)
      .positional("name", { describe: "task name (unique per directory)", type: "string", demandOption: true })
      .option("prompt", { type: "string", describe: "prompt text for each run" })
      .option("disabled", { type: "boolean", describe: "create the task disabled" })
      .demandOption("cron"),
  handler: Effect.fn("Cli.task.add")(function* (args) {
    if (!args.prompt) return yield* fail("--prompt is required")
    const directory = AbsolutePath.make(path.resolve(args.directory ?? process.cwd()))
    const fields = yield* editFields({ ...args, enabled: args.disabled ? false : undefined })
    const { db } = yield* Database.Service
    const info = yield* ScheduledTask.insert(db, {
      directory,
      name: args.name,
      cron: args.cron,
      prompt: args.prompt,
      ...fields,
    }).pipe(
      Effect.catchTag("Task.InvalidScheduleError", (error) => fail(`Invalid schedule: ${error.message}`)),
      Effect.catchTag("Task.DuplicateError", () => fail(`A task named "${args.name}" already exists in ${directory}`)),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Created ${info.id}`)
    printTask(info)
  }),
})

export const TaskEditCommand = effectCmd({
  command: "edit <name>",
  describe: "update a scheduled task",
  instance: false,
  builder: (yargs) =>
    sharedOptions(yargs)
      .positional("name", { describe: "task name or ID", type: "string", demandOption: true })
      .option("prompt", { type: "string", describe: "prompt text for each run" })
      .option("enable", { type: "boolean", describe: "enable the task (recomputes next run)" })
      .option("disable", { type: "boolean", describe: "disable the task" }),
  handler: Effect.fn("Cli.task.edit")(function* (args) {
    const directory = AbsolutePath.make(path.resolve(args.directory ?? process.cwd()))
    const task = yield* resolve(directory, args.name)
    const enabled = args.enable === args.disable ? undefined : (args.enable ?? !args.disable)
    const fields = yield* editFields({ ...args, enabled })
    const { db } = yield* Database.Service
    const info = yield* ScheduledTask.updateTask(db, task.id, {
      ...fields,
      ...(args.cron === undefined ? {} : { cron: args.cron }),
      ...(args.tz === undefined ? {} : { timezone: args.tz }),
      ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
    }).pipe(
      Effect.catchTag("Task.NotFoundError", () => fail(`No scheduled task "${args.name}"`)),
      Effect.catchTag("Task.InvalidScheduleError", (error) => fail(`Invalid schedule: ${error.message}`)),
      Effect.catchTag("Task.DuplicateError", (error) =>
        fail(`A task named "${error.name}" already exists in ${directory}`),
      ),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Updated ${info.id}`)
    printTask(info)
  }),
})

export const TaskRemoveCommand = effectCmd({
  command: "remove <name>",
  describe: "delete a scheduled task and its run history",
  instance: false,
  builder: (yargs) => sharedOptions(yargs).positional("name", { describe: "task name or ID", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.task.remove")(function* (args) {
    const directory = AbsolutePath.make(path.resolve(args.directory ?? process.cwd()))
    const task = yield* resolve(directory, args.name)
    const { db } = yield* Database.Service
    yield* ScheduledTask.removeTask(db, task.id)
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Removed ${task.id}`)
  }),
})

export const TaskRunCommand = effectCmd({
  command: "run <name>",
  describe: "queue an immediate run of a scheduled task",
  instance: false,
  builder: (yargs) => sharedOptions(yargs).positional("name", { describe: "task name or ID", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.task.run")(function* (args) {
    const directory = AbsolutePath.make(path.resolve(args.directory ?? process.cwd()))
    const task = yield* resolve(directory, args.name)
    const { db } = yield* Database.Service
    const run = yield* ScheduledTask.insertRun(db, { task, scheduledAt: Date.now() }).pipe(
      Effect.catchTag("Task.ActiveRunError", () => fail(`A run is already pending or running for "${task.name}"`)),
    )
    UI.println(
      UI.Style.TEXT_SUCCESS_BOLD + `Queued ${run.id}` + UI.Style.TEXT_NORMAL + " — the running server picks it up within a tick",
    )
  }),
})

export const TaskEnableCommand = effectCmd({
  command: "enable <name>",
  describe: "enable a scheduled task",
  instance: false,
  builder: (yargs) => sharedOptions(yargs).positional("name", { describe: "task name or ID", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.task.enable")(function* (args) {
    const directory = AbsolutePath.make(path.resolve(args.directory ?? process.cwd()))
    const task = yield* resolve(directory, args.name)
    const { db } = yield* Database.Service
    const info = yield* ScheduledTask.updateTask(db, task.id, { enabled: true }).pipe(
      Effect.catchTag("Task.NotFoundError", () => fail(`No scheduled task "${args.name}"`)),
      Effect.catchTag("Task.InvalidScheduleError", (error) => fail(`Invalid schedule: ${error.message}`)),
      Effect.catchTag("Task.DuplicateError", (error) =>
        fail(`A task named "${error.name}" already exists in this directory`),
      ),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Enabled ${info.id} — next: ${nextRun(info)}`)
  }),
})

export const TaskDisableCommand = effectCmd({
  command: "disable <name>",
  describe: "disable a scheduled task",
  instance: false,
  builder: (yargs) => sharedOptions(yargs).positional("name", { describe: "task name or ID", type: "string", demandOption: true }),
  handler: Effect.fn("Cli.task.disable")(function* (args) {
    const directory = AbsolutePath.make(path.resolve(args.directory ?? process.cwd()))
    const task = yield* resolve(directory, args.name)
    const { db } = yield* Database.Service
    const info = yield* ScheduledTask.updateTask(db, task.id, { enabled: false }).pipe(
      Effect.catchTag("Task.NotFoundError", () => fail(`No scheduled task "${args.name}"`)),
      Effect.catchTag("Task.InvalidScheduleError", (error) => fail(`Invalid schedule: ${error.message}`)),
      Effect.catchTag("Task.DuplicateError", (error) =>
        fail(`A task named "${error.name}" already exists in this directory`),
      ),
    )
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Disabled ${info.id}`)
  }),
})

export const TaskListCommand = effectCmd({
  command: "list",
  describe: "list scheduled tasks",
  instance: false,
  builder: (yargs) => yargs.option("directory", { type: "string", describe: "filter by directory (defaults to all)" }),
  handler: Effect.fn("Cli.task.list")(function* (args) {
    const { db } = yield* Database.Service
    const tasks = args.directory
      ? yield* ScheduledTask.byDirectory(db, path.resolve(args.directory))
      : yield* ScheduledTask.all(db)
    if (tasks.length === 0) {
      UI.println(UI.Style.TEXT_DIM + "No scheduled tasks")
      return
    }
    for (const task of tasks) {
      printTask(task)
      UI.println("")
    }
  }),
})

export const TaskRunsCommand = effectCmd({
  command: "runs <name>",
  describe: "show run history of a scheduled task",
  instance: false,
  builder: (yargs) =>
    sharedOptions(yargs)
      .positional("name", { describe: "task name or ID", type: "string", demandOption: true })
      .option("limit", { type: "number", describe: "maximum runs to show (default 20)" }),
  handler: Effect.fn("Cli.task.runs")(function* (args) {
    const directory = AbsolutePath.make(path.resolve(args.directory ?? process.cwd()))
    const task = yield* resolve(directory, args.name)
    const { db } = yield* Database.Service
    const runs = yield* ScheduledTask.runsForTask(db, task.id, args.limit ?? 20)
    if (runs.length === 0) {
      UI.println(UI.Style.TEXT_DIM + "No runs yet")
      return
    }
    UI.println(`  ${UI.Style.TEXT_NORMAL_BOLD}${task.name}${UI.Style.TEXT_NORMAL}`)
    for (const run of runs) printRun(run)
  }),
})

export const TaskValidateCommand = effectCmd({
  command: "validate <cron>",
  describe: "check a cron expression and print the next few fire times",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("cron", { describe: "five-field cron expression", type: "string", demandOption: true })
      .option("tz", { type: "string", describe: "IANA timezone" }),
  handler: Effect.fn("Cli.task.validate")(function* (args) {
    const invalid = TaskSchedule.validate({ cron: args.cron, timezone: args.tz })
    if (invalid) return yield* fail(`Invalid schedule: ${invalid.message}`)
    let after = Date.now()
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + "Valid schedule" + UI.Style.TEXT_NORMAL + " — next fire times:")
    for (let i = 0; i < 5; i++) {
      const next = TaskSchedule.nextAfter({ cron: args.cron, timezone: args.tz, after })
      UI.println(`  ${formatTime(next)}`)
      after = next
    }
  }),
})

export const TaskCommand = cmd({
  command: "task",
  describe: "manage scheduled tasks (server-managed cron for autonomous sessions)",
  builder: (yargs: Argv) =>
    yargs
      .command(TaskAddCommand)
      .command(TaskEditCommand)
      .command(TaskRemoveCommand)
      .command(TaskRunCommand)
      .command(TaskEnableCommand)
      .command(TaskDisableCommand)
      .command(TaskListCommand)
      .command(TaskRunsCommand)
      .command(TaskValidateCommand)
      .demandCommand(),
  async handler() {},
})
