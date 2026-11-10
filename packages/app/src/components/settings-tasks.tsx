import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { Select } from "@opencode-ai/ui/select"
import { Switch } from "@opencode-ai/ui/switch"
import { TextField } from "@opencode-ai/ui/text-field"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useNavigate } from "@solidjs/router"
import { createQuery, useMutation } from "@tanstack/solid-query"
import type { Task } from "@opencode-ai/schema/task"
import { DateTime, Duration } from "luxon"
import { For, Show, createResource, createSignal, onCleanup, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer, type ServerConnection } from "@/context/server"
import { useQueryOptions } from "@/context/server-sync"
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
  directory?: string
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

/** Result line for a finished run: success, or a problem with its reason. */
function runResult(language: { t: (key: string) => string }, run: Task.Run) {
  if (run.status === "completed") return { ok: true as const, label: language.t("settings.tasks.result.success") }
  if (run.reason === "timeout") return { ok: false as const, label: language.t("settings.tasks.reason.timeout") }
  if (run.reason === "interrupted") return { ok: false as const, label: language.t("settings.tasks.reason.interrupted") }
  if (run.reason === "cancelled" || run.status === "cancelled") {
    return { ok: false as const, label: language.t("settings.tasks.reason.cancelled") }
  }
  if (run.status === "pending" || run.status === "running") {
    return { ok: false as const, label: language.t(RUN_STATUS_KEYS[run.status]) }
  }
  return { ok: false as const, label: language.t("settings.tasks.result.problem") }
}

function createTasksApi(input: {
  server: () => ServerConnection.HttpBase | undefined
  fetch: typeof globalThis.fetch
}) {
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
    const response = await input.fetch(new URL(path, server.url), {
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
    listAll: () => request<{ data: Task.Info[] }>("/api/task?all=true").then((result) => result.data),
    create: (body: TaskSaveInput) => {
      const params = new URLSearchParams()
      params.append("location[directory]", body.directory ?? "/")
      return request<{ data: Task.Info }>(`/api/task?${params.toString()}`, { method: "POST", body }).then(
        (result) => result.data,
      )
    },
    update: (task: Task.Info, body: Partial<Omit<TaskSaveInput, "directory">>) => {
      const params = new URLSearchParams()
      params.append("location[directory]", task.directory)
      return request<{ data: Task.Info }>(`/api/task/${encodeURIComponent(task.id)}?${params.toString()}`, {
        method: "PATCH",
        body,
      }).then((result) => result.data)
    },
    remove: (task: Task.Info) => {
      const params = new URLSearchParams()
      params.append("location[directory]", task.directory)
      return request<void>(`/api/task/${encodeURIComponent(task.id)}?${params.toString()}`, { method: "DELETE" })
    },
    trigger: (task: Task.Info) => {
      const params = new URLSearchParams()
      params.append("location[directory]", task.directory)
      return request<{ data: Task.Run }>(`/api/task/${encodeURIComponent(task.id)}/trigger?${params.toString()}`, {
        method: "POST",
      }).then((result) => result.data)
    },
    listRuns: (task: Task.Info) => {
      const params = new URLSearchParams()
      params.append("location[directory]", task.directory)
      return request<{ data: Task.Run[] }>(`/api/task/${encodeURIComponent(task.id)}/run?${params.toString()}`).then(
        (result) => result.data,
      )
    },
    listRunsRecent: (limit: number) =>
      request<{ data: Array<{ task: Task.Info; run: Task.Run }> }>(`/api/task-runs?limit=${limit}`).then(
        (result) => result.data,
      ),
    validate: (body: { cron: string; timezone: string | null }) =>
      request<{ data: { next: number[] } }>("/api/task/validate", { method: "POST", body }).then(
        (result) => result.data,
      ),
  }
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return
}

// The published client snapshot bundled with this app predates the scheduled
// tasks API, so call the endpoints directly, mirroring utils/server.ts auth
// and the generated client's `location[directory]` deepObject query.

export function SettingsTasks() {
  const language = useLanguage()
  const server = useServer()
  const platform = usePlatform()
  const navigate = useNavigate()
  const queryOptions = useQueryOptions()
  const dialog = useDialog()

  const api = createTasksApi({
    server: () => server.current?.http,
    // fetch must stay bound to its global receiver; calling it as an object
    // method throws "Illegal invocation".
    fetch: (platform.fetch ?? globalThis.fetch).bind(globalThis),
  })

  const [view, setView] = createStore({ mode: "list" as "list" | "form", task: undefined as Task.Info | undefined })
  const [expanded, setExpanded] = createSignal<string>()
  const [activeRuns, setActiveRuns] = createStore<Record<string, boolean>>({})
  const [directoryFilter, setDirectoryFilter] = createSignal("all")

  const tasksQuery = createQuery(() => ({
    queryKey: ["tasks", "all"],
    queryFn: () => api.listAll(),
  }))

  const [recentRuns, recentRunsActions] = createResource(() => api.listRunsRecent(15))

  const [runs, runsActions] = createResource(expanded, (taskID: string) => {
    const task = (tasksQuery.data ?? []).find((item) => item.id === taskID)
    if (!task) return Promise.resolve([])
    return api.listRuns(task)
  })

  // Root-project agents: global agents are the sane default for the fleet
  // view; the tasks themselves may live in any directory.
  const agentsQuery = createQuery(() => queryOptions().agents(pathKey("/")))

  const tasks = () => tasksQuery.data ?? []
  const directories = () => [...new Set(tasks().map((task) => task.directory))].toSorted()
  const visibleTasks = () => {
    const filter = directoryFilter()
    return filter === "all" ? tasks() : tasks().filter((task) => task.directory === filter)
  }

  const refresh = () => {
    void tasksQuery.refetch()
    void recentRunsActions.refetch()
    if (expanded()) void runsActions.refetch()
  }

  // Settings has no directory SDK event stream; poll instead. Runs update a
  // few times per minute while a run is in flight.
  const refreshTimer = setInterval(refresh, 30_000)
  onCleanup(() => clearInterval(refreshTimer))

  const toggleMutation = useMutation(() => ({
    mutationFn: (input: { task: Task.Info; enabled: boolean }) => api.update(input.task, { enabled: input.enabled }),
    onSuccess: () => refresh(),
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("dialog.tasks.toggle.failed"),
        description: errorMessage(error) ?? language.t("common.requestFailed"),
      }),
  }))

  const triggerMutation = useMutation(() => ({
    mutationFn: (task: Task.Info) => api.trigger(task),
    onSuccess: (run) => {
      setActiveRuns(run.taskID, run.status === "pending" || run.status === "running")
      refresh()
    },
    onError: (error) =>
      showToast({
        variant: "error",
        title: language.t("dialog.tasks.trigger.failed"),
        description: errorMessage(error) ?? language.t("common.requestFailed"),
      }),
  }))

  const removeMutation = useMutation(() => ({
    mutationFn: (task: Task.Info) => api.remove(task),
    onSuccess: (_, task) => {
      if (expanded() === task.id) setExpanded(undefined)
      refresh()
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

  const openSession = (targetDirectory: string | undefined, sessionID: string) => {
    if (!targetDirectory) return
    navigate(legacySessionHref(targetDirectory, sessionID))
  }

  const openCreate = () => {
    setView({ mode: "form", task: undefined })
  }
  const openEdit = (task: Task.Info) => {
    setView({ mode: "form", task })
  }
  const closeForm = () => {
    setView({ mode: "list", task: undefined })
    refresh()
  }

  const confirmRemove = (task: Task.Info) => {
    void dialog.push(() => (
      <SettingsTasksRemove
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

  const agentOptions = () => [
    { value: "", label: language.t("dialog.tasks.form.agent.default") },
    ...(agentsQuery.data ?? [])
      .filter((agent) => !agent.hidden)
      .map((agent) => ({ value: agent.name, label: agent.name })),
  ]

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <Show
        when={view.mode === "list"}
        fallback={
          <TaskForm
            task={view.task}
            api={api}
            agents={agentOptions()}
            fallbackDirectory="/"
            onDone={closeForm}
          />
        }
      >
        <div class="flex items-center justify-between gap-2 pb-3">
          <span class="text-13-regular text-text-weak">{language.t("settings.tasks.description")}</span>
          <Button icon="plus-small" tabIndex={-1} onClick={openCreate}>
            {language.t("dialog.tasks.new")}
          </Button>
        </div>
        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          <section class="flex flex-col gap-2">
            <span class="text-13-medium text-text-strong">{language.t("settings.tasks.recent")}</span>
            <Show
              when={!recentRuns.loading}
              fallback={<SettingsTasksStatus text={language.t("common.loading")} />}
            >
              <Show
                when={(recentRuns.latest ?? []).length > 0}
                fallback={<SettingsTasksStatus text={language.t("dialog.tasks.run.history.empty")} />}
              >
                <div class="flex flex-col divide-y rounded-md border border-border-weak-base">
                  <For each={recentRuns.latest ?? []}>
                    {(entry) => {
                      const result = () => runResult(language, entry.run)
                      return (
                        <div class="flex items-center justify-between gap-2 px-3 py-2 text-12-regular">
                          <div class="flex min-w-0 flex-col">
                            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                              <span class="flex items-center gap-1">
                                <span
                                  class="size-1.5 rounded-full shrink-0"
                                  classList={{
                                    "bg-icon-success-base": result().ok,
                                    "bg-icon-error-base": !result().ok,
                                  }}
                                />
                                {result().label}
                              </span>
                              <span class="text-text-strong">{entry.task.name}</span>
                              <span class="text-text-weaker">{entry.task.directory}</span>
                              <span class="text-text-weaker">{language.t(RUN_TRIGGER_KEYS[entry.run.trigger])}</span>
                              <span class="text-text-weaker">{formatTime(entry.run.timeCompleted ?? entry.run.scheduledAt)}</span>
                              <Show when={formatDuration(entry.run.timeStarted, entry.run.timeCompleted)}>
                                {(duration) => <span class="text-text-weaker">{duration()}</span>}
                              </Show>
                            </div>
                            <Show when={entry.run.error}>
                              <span class="truncate text-text-weaker">{entry.run.error}</span>
                            </Show>
                          </div>
                          <Show when={entry.run.sessionID}>
                            {(sessionID) => (
                              <button
                                type="button"
                                class="max-w-[40%] truncate font-mono text-text-weak hover:text-text-strong"
                                onClick={() => openSession(entry.task.directory, sessionID())}
                              >
                                {language.t("dialog.tasks.run.session", { id: sessionID() })}
                              </button>
                            )}
                          </Show>
                        </div>
                      )
                    }}
                  </For>
                </div>
              </Show>
            </Show>
          </section>

          <section class="flex flex-col gap-2">
            <div class="flex items-center justify-between gap-2">
              <span class="text-13-medium text-text-strong">{language.t("dialog.tasks.title")}</span>
              <Show when={directories().length > 0}>
                <Select
                  options={[{ value: "all", label: language.t("settings.tasks.directory.all") }].concat(
                    directories().map((item) => ({ value: item, label: item })),
                  )}
                  value={(option) => option.value}
                  label={(option) => option.label}
                  current={
                    [{ value: "all", label: language.t("settings.tasks.directory.all") }]
                      .concat(directories().map((item) => ({ value: item, label: item })))
                      .find((option) => option.value === directoryFilter()) ?? {
                      value: "all",
                      label: language.t("settings.tasks.directory.all"),
                    }
                  }
                  onSelect={(option) => setDirectoryFilter(option?.value ?? "all")}
                  variant="secondary"
                  size="small"
                />
              </Show>
            </div>
            <Show when={!tasksQuery.isLoading} fallback={<SettingsTasksStatus text={language.t("common.loading")} />}>
              <Show
                when={!tasksQuery.error}
                fallback={
                  <SettingsTasksStatus
                    text={errorMessage(tasksQuery.error) ?? language.t("common.requestFailed")}
                    onRetry={() => void tasksQuery.refetch()}
                  />
                }
              >
                <Show when={visibleTasks().length > 0} fallback={<SettingsTasksStatus text={language.t("dialog.tasks.empty")} />}>
                  <For each={visibleTasks()}>
                    {(task) => (
                      <div class="flex flex-col gap-2 border-t border-border-weak-base py-3 first:border-t-0 first:pt-0">
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
                          <span class="text-text-weaker">{task.directory}</span>
                          <span>{language.t("dialog.tasks.cron", { cron: task.cron })}</span>
                          <Show when={task.timezone}>{(timezone) => <span>{timezone()}</span>}</Show>
                          <Show when={task.agent}>
                            {(agent) => <span>{language.t("dialog.tasks.form.agent")}: {agent()}</span>}
                          </Show>
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
                                fallback={<SettingsTasksStatus text={language.t("common.requestFailed")} onRetry={() => void runsActions.refetch()} />}
                              >
                                <Show
                                  when={(runs.latest ?? []).length > 0}
                                  fallback={<SettingsTasksStatus text={language.t("dialog.tasks.run.history.empty")} />}
                                >
                                  <For each={runs.latest ?? []}>
                                    {(run) => {
                                      const result = () => runResult(language, run)
                                      return (
                                        <div class="flex items-center justify-between gap-2 text-12-regular">
                                          <div class="flex min-w-0 flex-col">
                                            <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-text-weaker">
                                              <span class="flex items-center gap-1">
                                                <span
                                                  class="size-1.5 rounded-full shrink-0"
                                                  classList={{
                                                    "bg-icon-success-base": result().ok,
                                                    "bg-icon-error-base": !result().ok,
                                                  }}
                                                />
                                                {result().label}
                                              </span>
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
                                                onClick={() => openSession(task.directory, sessionID())}
                                              >
                                                {language.t("dialog.tasks.run.session", { id: sessionID() })}
                                              </button>
                                            )}
                                          </Show>
                                        </div>
                                      )
                                    }}
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
          </section>
        </div>
      </Show>
    </div>
  )
}

function SettingsTasksStatus(props: { text: string; onRetry?: () => void }) {
  const language = useLanguage()
  return (
    <div class="flex flex-col items-center gap-2 px-4 py-6">
      <span class="text-13-regular text-text-weak">{props.text}</span>
      <Show when={props.onRetry}>
        <Button size="small" onClick={props.onRetry}>
          {language.t("common.retry")}
        </Button>
      </Show>
    </div>
  )
}

function SettingsTasksRemove(props: { task: Task.Info; pending: boolean; onCancel: () => void; onConfirm: (task: Task.Info) => void }) {
  const language = useLanguage()
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
  directory: "",
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
  directory: string
  errors: { name?: string; cron?: string; prompt?: string; submit?: string }
}

function TaskForm(props: {
  task?: Task.Info
  api: TasksApi
  agents: { value: string; label: string }[]
  fallbackDirectory: string
  onDone: () => void
}) {
  const language = useLanguage()
  const [form, setForm] = createStore<TaskFormState>(formState(props.task, props.fallbackDirectory))
  const [cronCheck, setCronCheck] = createSignal<{ cron: string; timezone: string }>()

  const [checkResult] = createResource(cronCheck, (input) =>
    props.api.validate({ cron: input.cron, timezone: input.timezone || null }),
  )

  const checkCron = () => {
    const cron = form.cron.trim()
    if (!cron) {
      setCronCheck(undefined)
      return
    }
    setCronCheck({ cron, timezone: form.timezone.trim() })
  }

  // Keep the current agent selectable when it is missing from the fetched list.
  const agentOptions = () => {
    if (!form.agent || props.agents.some((option) => option.value === form.agent)) return props.agents
    return [...props.agents, { value: form.agent, label: form.agent }]
  }

  const setField = (key: Exclude<keyof TaskFormState, "errors" | "enabled">, value: string) => {
    setForm(key, value)
    if (key === "name" || key === "cron" || key === "prompt") setForm("errors", key, undefined)
    // The preview reflects the last checked schedule; stale results reset.
    if (key === "cron" || key === "timezone") setCronCheck(undefined)
    setForm("errors", "submit", undefined)
  }
  const setEnabled = (value: boolean) => setForm("enabled", value)

  const saveMutation = useMutation(() => ({
    mutationFn: (body: TaskSaveInput) => (props.task ? props.api.update(props.task, body) : props.api.create(body)),
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

  const nextFire = () => checkResult.latest?.next?.[0]
  const cronInvalid = () => !checkResult.loading && cronCheck() !== undefined && (checkResult.latest?.next?.length ?? 0) === 0
  const formatTime = (value: number | undefined) => {
    if (!value) return
    return DateTime.fromMillis(value).setLocale(language.intl()).toLocaleString(DateTime.DATETIME_MED)
  }

  return (
    <form class="flex flex-col gap-3" onSubmit={submit}>
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
          onBlur={checkCron}
          error={form.errors.cron || (cronInvalid() ? language.t("settings.tasks.form.cron.invalid") : undefined)}
        />
        <TextField
          label={language.t("dialog.tasks.form.timezone")}
          placeholder={language.t("dialog.tasks.form.timezone.placeholder")}
          value={form.timezone}
          onChange={(value) => setField("timezone", value)}
          onBlur={checkCron}
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
      <Show
        when={props.task}
        fallback={
          <TextField
            label={language.t("settings.tasks.form.directory")}
            placeholder={language.t("settings.tasks.form.directory.placeholder")}
            value={form.directory ?? ""}
            onChange={(value) => setForm("directory", value)}
          />
        }
      >
        <div class="flex flex-col gap-1">
          <span class="text-12-medium text-text-weak">{language.t("settings.tasks.form.directory")}</span>
          <span class="text-12-regular text-text-weak">{props.task?.directory}</span>
        </div>
      </Show>
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
        <span class="text-11-regular text-text-weaker">{language.t("dialog.tasks.form.agent.hint")}</span>
      </div>
      <Show when={cronCheck() && (checkResult.loading || nextFire())}>
        <span class="text-11-regular text-text-weaker">
          {checkResult.loading
            ? language.t("settings.tasks.form.cron.checking")
            : `${language.t("settings.tasks.form.cron.next")} ${formatTime(nextFire())}`}
        </span>
      </Show>
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

function formState(task: Task.Info | undefined, fallbackDirectory?: string): TaskFormState {
  if (!task) return { ...emptyForm, directory: fallbackDirectory ?? "", errors: {} }
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
    directory: task.directory,
    errors: {},
  }
}

function parseNonNegativeInt(value: string): number | null | undefined {
  if (value.trim() === "") return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) return undefined
  return parsed
}

function parseModelRef(value: string): TaskModelRef | null {
  const [providerID, id] = value.split("/")
  if (!providerID || !id) return null
  return { providerID, id } as TaskModelRef
}

function formatModelRef(model: TaskModelRef): string {
  return `${model.providerID}/${model.id}`
}
