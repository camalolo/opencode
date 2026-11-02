import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useNavigate } from "@solidjs/router"
import { createQuery, useMutation } from "@tanstack/solid-query"
import type { Task } from "@opencode-ai/schema/task"
import { DateTime, Duration } from "luxon"
import { For, Show, createResource, createSignal, onCleanup, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer, type ServerConnection } from "@/context/server"
import { useQueryOptions } from "@/context/server-sync"
import { useSDK } from "@/context/sdk"
import { legacySessionHref } from "@/utils/session-route"
import { pathKey } from "@/utils/path-key"
import { authTokenFromCredentials } from "@/utils/server"
import { showToast } from "@/utils/toast"

const RUN_STATUS_KEYS = {
  pending: "dialog.tasks.run.status.pending",
  running: "dialog.tasks.run.status.running",
  completed: "dialog.tasks.run.status.completed",
  failed: "dialog.tasks.run.status.failed",
  skipped: "dialog.tasks.run.status.skipped",
  cancelled: "dialog.tasks.run.status.cancelled",
} as const

const RUN_TRIGGER_KEYS = {
  schedule: "dialog.tasks.run.trigger.schedule",
  manual: "dialog.tasks.run.trigger.manual",
} as const

type TaskModelRef = NonNullable<Task.Info["model"]>

type TaskSaveInput = {
  name: string
  description: string | null
  cron: string
  timezone: string | null
  agent: string | null
  model: TaskModelRef | null
  prompt: string
  enabled: boolean
  runTimeoutMs: number | null
  retainRuns: number | null
}

type TasksApi = ReturnType<typeof createTasksApi>

export const DialogTasks: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useSDK()
  const server = useServer()
  const platform = usePlatform()
  const navigate = useNavigate()
  const queryOptions = useQueryOptions()

  const directory = () => sdk().directory
  const api = createTasksApi({
    server: () => server.current?.http,
    // fetch must stay bound to its global receiver; calling it as an object
    // method throws "Illegal invocation".
    fetch: (platform.fetch ?? globalThis.fetch).bind(globalThis),
    directory,
  })

  const [view, setView] = createStore({ mode: "list" as "list" | "form", task: undefined as Task.Info | undefined })
  const [expanded, setExpanded] = createSignal<string>()
  const [activeRuns, setActiveRuns] = createStore<Record<string, boolean>>({})

  const tasksQuery = createQuery(() => ({
    queryKey: ["tasks", directory()],
    queryFn: () => api.list(),
  }))

  const [runs, runsActions] = createResource(expanded, (taskID: string) => api.listRuns(taskID))

  // The typed SDK event union predates the task events, so match on raw names.
  onCleanup(
    sdk().event.listen((event) => {
      const name = event.name as string
      if (name === "task.updated") {
        void tasksQuery.refetch()
        return
      }
      if (name !== "task.run.updated") return
      const run = (event.details as { properties?: { run?: Task.Run } }).properties?.run
      if (!run) return
      setActiveRuns(run.taskID, run.status === "pending" || run.status === "running")
      if (expanded() === run.taskID) void runsActions.refetch()
    }),
  )

  const agentsQuery = createQuery(() => queryOptions().agents(pathKey(directory())))
  const agentOptions = () => [
    { value: "", label: language.t("dialog.tasks.form.agent.default") },
    ...(agentsQuery.data ?? [])
      .filter((agent) => !agent.hidden)
      .map((agent) => ({ value: agent.name, label: agent.name })),
  ]

  const toggleMutation = useMutation(() => ({
    mutationFn: (input: { task: Task.Info; enabled: boolean }) => api.update(input.task.id, { enabled: input.enabled }),
    onSuccess: () => void tasksQuery.refetch(),
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("dialog.tasks.toggle.failed"),
        description: errorMessage(error) ?? language.t("common.requestFailed"),
      }),
  }))

  const triggerMutation = useMutation(() => ({
    mutationFn: (task: Task.Info) => api.trigger(task.id),
    onSuccess: (run) => {
      setActiveRuns(run.taskID, run.status === "pending" || run.status === "running")
      void tasksQuery.refetch()
      if (expanded() === run.taskID) void runsActions.refetch()
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("dialog.tasks.trigger.failed"),
        description: errorMessage(error) ?? language.t("common.requestFailed"),
      }),
  }))

  const removeMutation = useMutation(() => ({
    mutationFn: (task: Task.Info) => api.remove(task.id),
    onSuccess: (_, task) => {
      if (expanded() === task.id) setExpanded(undefined)
      void tasksQuery.refetch()
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("dialog.tasks.delete.failed"),
        description: errorMessage(error) ?? language.t("common.requestFailed"),
      }),
  }))

  const formatTime = (value: number | undefined) => {
    if (!value) return
    return DateTime.fromMillis(value).setLocale(language.intl()).toLocaleString(DateTime.DATETIME_MED)
  }
  const formatDuration = (started: number | undefined, completed: number | undefined) => {
    if (!started || !completed) return
    return Duration.fromMillis(completed - started).toFormat("h:mm:ss")
  }

  const openSession = (sessionID: string) => {
    const value = directory()
    if (!value) return
    dialog.close()
    navigate(legacySessionHref(value, sessionID))
  }

  const openCreate = () => {
    setView({ mode: "form", task: undefined })
  }
  const openEdit = (task: Task.Info) => {
    setView({ mode: "form", task })
  }
  const closeForm = () => {
    setView({ mode: "list", task: undefined })
    void tasksQuery.refetch()
  }

  const confirmRemove = (task: Task.Info) => {
    void dialog.push(() => (
      <DialogTasksRemove
        task={task}
        pending={removeMutation.isPending && removeMutation.variables === task}
        onCancel={() => dialog.close()}
        onConfirm={(confirmed) => {
          dialog.close()
          removeMutation.mutate(confirmed)
        }}
      />
    ))
  }

  const title = () =>
    view.mode === "list"
      ? language.t("dialog.tasks.title")
      : view.task
        ? language.t("dialog.tasks.form.edit.title")
        : language.t("dialog.tasks.new")

  return (
    <Dialog
      size="large"
      title={title()}
      description={view.mode === "list" ? language.t("dialog.tasks.description") : undefined}
      action={
        <Show
          when={view.mode === "list"}
          fallback={<Button variant="ghost" onClick={closeForm}>{language.t("common.cancel")}</Button>}
        >
          <Button icon="plus-small" tabIndex={-1} onClick={openCreate}>
            {language.t("dialog.tasks.new")}
          </Button>
        </Show>
      }
    >
      <Show
        when={view.mode === "list"}
        fallback={
          <TaskForm
            task={view.task}
            api={api}
            agents={agentOptions()}
            onDone={closeForm}
          />
        }
      >
        <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <Show when={!tasksQuery.isLoading} fallback={<DialogTasksStatus text={language.t("common.loading")} />}>
            <Show
              when={!tasksQuery.error}
              fallback={
                <DialogTasksStatus
                  text={
                    errorMessage(tasksQuery.error) ?? language.t("common.requestFailed")
                  }
                  onRetry={() => void tasksQuery.refetch()}
                />
              }
            >
              <Show when={(tasksQuery.data ?? []).length > 0} fallback={<DialogTasksStatus text={language.t("dialog.tasks.empty")} />}>
                <For each={tasksQuery.data ?? []}>
                  {(task) => (
                    <div class="flex flex-col gap-2 px-4 py-3">
                      <div class="flex items-center gap-2">
                        <button
                          type="button"
                          class="flex min-w-0 flex-1 items-center gap-2 text-left"
                          onClick={() => setExpanded(expanded() === task.id ? undefined : task.id)}
                        >
                          <Icon
                            name="chevron-down"
                            size="small"
                            classList={{ "-rotate-90": expanded() !== task.id }}
                          />
                          <span class="truncate text-14-medium text-text-strong">{task.name}</span>
                          <Show when={task.description}>
                            <span class="truncate text-12-regular text-text-weak">{task.description}</span>
                          </Show>
                        </button>
                        <Switch
                          checked={task.enabled}
                          disabled={toggleMutation.isPending && toggleMutation.variables?.task.id === task.id}
                          onChange={(checked) => toggleMutation.mutate({ task, enabled: checked })}
                          hideLabel
                        >
                          {task.name}
                        </Switch>
                      </div>
                      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-12-regular text-text-weak">
                        <span>{language.t("dialog.tasks.cron", { cron: task.cron })}</span>
                        <Show when={task.timezone}>{(timezone) => <span>{timezone()}</span>}</Show>
                        <Show when={task.enabled && formatTime(task.nextRunAt)}>
                          {(time) => <span>{language.t("dialog.tasks.nextRun", { time: time() })}</span>}
                        </Show>
                      </div>
                      <div class="flex items-center gap-2">
                        <Button
                          size="small"
                          onClick={() => triggerMutation.mutate(task)}
                          disabled={activeRuns[task.id] || (triggerMutation.isPending && triggerMutation.variables === task)}
                        >
                          {language.t("dialog.tasks.run.now")}
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => openEdit(task)}>
                          {language.t("common.edit")}
                        </Button>
                        <Button size="small" variant="ghost" onClick={() => confirmRemove(task)}>
                          {language.t("common.delete")}
                        </Button>
                      </div>
                      <Show when={expanded() === task.id}>
                        <div class="flex flex-col gap-1 rounded-md bg-surface-base px-3 py-2">
                          <span class="text-12-medium text-text-weak">{language.t("dialog.tasks.run.history")}</span>
                          <Show
                            when={!runs.loading}
                            fallback={
                              <span class="text-12-regular text-text-weaker">
                                {language.t("common.loading")}
                                {language.t("common.loading.ellipsis")}
                              </span>
                            }
                          >
                            <Show
                              when={!runs.error}
                              fallback={<DialogTasksStatus text={language.t("common.requestFailed")} onRetry={() => void runsActions.refetch()} />}
                            >
                              <Show
                                when={(runs.latest ?? []).length > 0}
                                fallback={<DialogTasksStatus text={language.t("dialog.tasks.run.history.empty")} />}
                              >
                                <For each={runs.latest ?? []}>
                                  {(run) => (
                                    <div class="flex items-center justify-between gap-2 text-12-regular">
                                      <div class="flex min-w-0 flex-col">
                                        <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-text-weaker">
                                          <span>{language.t(RUN_STATUS_KEYS[run.status])}</span>
                                          <span>{language.t(RUN_TRIGGER_KEYS[run.trigger])}</span>
                                          <span>{formatTime(run.scheduledAt)}</span>
                                          <Show when={formatDuration(run.timeStarted, run.timeCompleted)}>
                                            {(duration) => <span>{duration()}</span>}
                                          </Show>
                                        </div>
                                        <Show when={run.error}>
                                          <span class="truncate text-text-weaker">{run.error}</span>
                                        </Show>
                                      </div>
                                      <Show when={run.sessionID}>
                                        {(sessionID) => (
                                          <button
                                            type="button"
                                            class="max-w-[40%] truncate font-mono text-text-weak hover:text-text-strong"
                                            onClick={() => openSession(sessionID())}
                                          >
                                            {language.t("dialog.tasks.run.session", { id: sessionID() })}
                                          </button>
                                        )}
                                      </Show>
                                    </div>
                                  )}
                                </For>
                              </Show>
                            </Show>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </Show>
          </Show>
        </div>
      </Show>
    </Dialog>
  )
}

function DialogTasksStatus(props: { text: string; onRetry?: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex flex-col items-center gap-2 px-4 py-8">
      <span class="text-13-regular text-text-weak">{props.text}</span>
      <Show when={props.onRetry}>
        <Button size="small" onClick={props.onRetry}>
          {language.t("common.retry")}
        </Button>
      </Show>
    </div>
  )
}

function DialogTasksRemove(props: { task: Task.Info; pending: boolean; onCancel: () => void; onConfirm: (task: Task.Info) => void }) {
  const language = useLanguage()
  const dialog = useDialog()
  return (
    <Dialog title={language.t("dialog.tasks.delete.confirm.title")} fit>
      <div class="flex flex-col gap-4 pl-6 pr-2.5 pb-3">
        <span class="text-14-regular text-text-strong">
          {language.t("dialog.tasks.delete.confirm.message", { name: props.task.name })}
        </span>
        <div class="flex justify-end gap-2">
          <Button variant="ghost" size="large" onClick={() => props.onCancel()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="primary" size="large" disabled={props.pending} onClick={() => props.onConfirm(props.task)}>
            {language.t("common.delete")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

const emptyForm: TaskFormState = {
  name: "",
  description: "",
  cron: "",
  timezone: "",
  agent: "",
  model: "",
  prompt: "",
  runTimeoutMs: "",
  retainRuns: "",
  enabled: true,
  errors: {},
}

type TaskFormState = {
  name: string
  description: string
  cron: string
  timezone: string
  agent: string
  model: string
  prompt: string
  runTimeoutMs: string
  retainRuns: string
  enabled: boolean
  errors: { name?: string; cron?: string; prompt?: string; submit?: string }
}

function TaskForm(props: { task?: Task.Info; api: TasksApi; agents: { value: string; label: string }[]; onDone: () => void }) {
  const language = useLanguage()
  const [form, setForm] = createStore<TaskFormState>(formState(props.task))

  // Keep the current agent selectable when it is missing from the fetched list.
  const agentOptions = () => {
    if (!form.agent || props.agents.some((option) => option.value === form.agent)) return props.agents
    return [...props.agents, { value: form.agent, label: form.agent }]
  }

  const setField = (key: Exclude<keyof TaskFormState, "errors" | "enabled">, value: string) => {
    setForm(key, value)
    if (key === "name" || key === "cron" || key === "prompt") setForm("errors", key, undefined)
    setForm("errors", "submit", undefined)
  }
  const setEnabled = (value: boolean) => setForm("enabled", value)

  const saveMutation = useMutation(() => ({
    mutationFn: (body: TaskSaveInput) => (props.task ? props.api.update(props.task.id, body) : props.api.create(body)),
    onSuccess: () => props.onDone(),
    onError: (error) =>
      setForm("errors", "submit", errorMessage(error) ?? language.t("dialog.tasks.form.error.submit")),
  }))

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const errors: TaskFormState["errors"] = {}
    if (!form.name.trim()) errors.name = language.t("dialog.tasks.form.error.name")
    if (!form.cron.trim()) errors.cron = language.t("dialog.tasks.form.error.cron")
    if (!form.prompt.trim()) errors.prompt = language.t("dialog.tasks.form.error.prompt")
    setForm("errors", errors)
    if (errors.name || errors.cron || errors.prompt) return

    const runTimeoutMs = parseNonNegativeInt(form.runTimeoutMs)
    const retainRuns = parseNonNegativeInt(form.retainRuns)
    if (runTimeoutMs === undefined || retainRuns === undefined) {
      setForm("errors", "submit", language.t("dialog.tasks.form.error.number"))
      return
    }

    saveMutation.mutate({
      name: form.name.trim(),
      description: form.description.trim() || null,
      cron: form.cron.trim(),
      timezone: form.timezone.trim() || null,
      agent: form.agent.trim() || null,
      model: parseModelRef(form.model),
      prompt: form.prompt,
      enabled: form.enabled,
      runTimeoutMs,
      retainRuns,
    })
  }

  return (
    <form class="flex flex-col gap-3 px-4 pb-4" onSubmit={submit}>
      <div class="grid grid-cols-2 gap-3">
        <TextField
          label={language.t("dialog.tasks.form.name")}
          placeholder={language.t("dialog.tasks.form.name.placeholder")}
          value={form.name}
          onChange={(value) => setField("name", value)}
          error={form.errors.name}
          autofocus
        />
        <TextField
          label={language.t("dialog.tasks.form.cron")}
          placeholder={language.t("dialog.tasks.form.cron.placeholder")}
          value={form.cron}
          onChange={(value) => setField("cron", value)}
          error={form.errors.cron}
        />
        <TextField
          label={language.t("dialog.tasks.form.timezone")}
          placeholder={language.t("dialog.tasks.form.timezone.placeholder")}
          value={form.timezone}
          onChange={(value) => setField("timezone", value)}
        />
        <TextField
          label={language.t("dialog.tasks.form.model")}
          placeholder={language.t("dialog.tasks.form.model.placeholder")}
          value={form.model}
          onChange={(value) => setField("model", value)}
        />
        <TextField
          label={language.t("dialog.tasks.form.timeout")}
          value={form.runTimeoutMs}
          onChange={(value) => setField("runTimeoutMs", value)}
        />
        <TextField
          label={language.t("dialog.tasks.form.retain")}
          value={form.retainRuns}
          onChange={(value) => setField("retainRuns", value)}
        />
      </div>
      <div class="flex flex-col gap-1">
        <span class="text-12-medium text-text-weak">{language.t("dialog.tasks.form.agent")}</span>
        <Select
          options={agentOptions()}
          value={(option) => option.value}
          label={(option) => option.label}
          current={agentOptions().find((option) => option.value === form.agent) ?? agentOptions()[0]}
          onSelect={(option) => setField("agent", option?.value ?? "")}
          variant="secondary"
          size="small"
        />
      </div>
      <TextField
        label={language.t("dialog.tasks.form.description")}
        placeholder={language.t("dialog.tasks.form.description.placeholder")}
        value={form.description}
        onChange={(value) => setField("description", value)}
      />
      <TextField
        label={language.t("dialog.tasks.form.prompt")}
        placeholder={language.t("dialog.tasks.form.prompt.placeholder")}
        value={form.prompt}
        onChange={(value) => setField("prompt", value)}
        error={form.errors.prompt}
        multiline
      />
      <Switch checked={form.enabled} onChange={(checked) => setEnabled(checked)}>
        {language.t("dialog.tasks.form.enabled")}
      </Switch>
      <Show when={form.errors.submit}>
        <span class="text-12-regular text-text-error">{form.errors.submit}</span>
      </Show>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={props.onDone}>
          {language.t("common.cancel")}
        </Button>
        <Button type="submit" variant="primary" disabled={saveMutation.isPending}>
          {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
        </Button>
      </div>
    </form>
  )
}

function formState(task: Task.Info | undefined): TaskFormState {
  if (!task) return { ...emptyForm, errors: {} }
  return {
    name: task.name,
    description: task.description ?? "",
    cron: task.cron,
    timezone: task.timezone ?? "",
    agent: task.agent ?? "",
    model: task.model ? formatModelRef(task.model) : "",
    prompt: task.prompt,
    runTimeoutMs: task.runTimeoutMs === undefined ? "" : String(task.runTimeoutMs),
    retainRuns: task.retainRuns === undefined ? "" : String(task.retainRuns),
    enabled: task.enabled,
    errors: {},
  }
}

export function useTasksCommand() {
  const command = useCommand()
  const language = useLanguage()
  const dialog = useDialog()

  const show = () => {
    void dialog.show(() => <DialogTasks />)
  }

  command.register("tasks", () => [
    {
      id: "tasks.open",
      title: language.t("command.tasks.open"),
      category: language.t("command.category.project"),
      onSelect: show,
    },
  ])

  return show
}

function parseNonNegativeInt(value: string) {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) return undefined
  return parsed
}

function parseModelRef(value: string): TaskModelRef | null {
  const parts = value.trim().split("/").filter(Boolean)
  if (parts.length < 2) return null
  // Free text crosses the branded-ID boundary here by design.
  const [providerID, id] = parts as [TaskModelRef["providerID"], TaskModelRef["id"]]
  const variant = parts[2] as TaskModelRef["variant"] | undefined
  return variant ? { providerID, id, variant } : { providerID, id }
}

function formatModelRef(model: TaskModelRef) {
  return model.variant ? `${model.providerID}/${model.id}/${model.variant}` : `${model.providerID}/${model.id}`
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return
}

// The published client snapshot bundled with this app predates the scheduled
// tasks API, so call the endpoints directly, mirroring utils/server.ts auth
// and the generated client's `location[directory]` deepObject query.
function createTasksApi(input: {
  server: () => ServerConnection.HttpBase | undefined
  fetch: typeof globalThis.fetch
  directory: () => string | undefined
}) {
  const locationQuery = () => {
    const directory = input.directory()
    if (!directory) return ""
    const params = new URLSearchParams()
    params.append("location[directory]", directory)
    return `?${params.toString()}`
  }

  const request = async <T,>(
    path: string,
    init?: { method?: "POST" | "PATCH" | "DELETE"; body?: unknown },
  ): Promise<T> => {
    const server = input.server()
    if (!server) throw new Error("No server connection")
    const headers: Record<string, string> = {}
    if (server.password)
      headers.Authorization = `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`
    if (init?.body !== undefined) headers["Content-Type"] = "application/json"
    const response = await input.fetch(new URL(`${path}${locationQuery()}`, server.url), {
      method: init?.method,
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (response.status === 204) return undefined as T
    const payload: unknown = await response.json().catch(() => undefined)
    if (!response.ok) throw payload
    return payload as T
  }

  return {
    list: () => request<{ data: Task.Info[] }>("/api/task").then((result) => result.data),
    create: (body: TaskSaveInput) =>
      request<{ data: Task.Info }>("/api/task", { method: "POST", body }).then((result) => result.data),
    update: (taskID: string, body: Partial<TaskSaveInput>) =>
      request<{ data: Task.Info }>(`/api/task/${encodeURIComponent(taskID)}`, { method: "PATCH", body }).then(
        (result) => result.data,
      ),
    remove: (taskID: string) => request<void>(`/api/task/${encodeURIComponent(taskID)}`, { method: "DELETE" }),
    trigger: (taskID: string) =>
      request<{ data: Task.Run }>(`/api/task/${encodeURIComponent(taskID)}/trigger`, { method: "POST" }).then(
        (result) => result.data,
      ),
    listRuns: (taskID: string) =>
      request<{ data: Task.Run[] }>(`/api/task/${encodeURIComponent(taskID)}/run`).then((result) => result.data),
  }
}
