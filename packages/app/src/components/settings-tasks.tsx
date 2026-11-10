import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Field } from "@opencode-ai/ui/v2/field-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { Dialog, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
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
import { SettingsListV2 } from "./settings-v2/parts/list"
import { SettingsRowV2 } from "./settings-v2/parts/row"
import "./settings-v2/settings-v2.css"

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
    return { ok: false as const, label: language.t("dialog.tasks.run.status." + run.status) }
  }
  return { ok: false as const, label: language.t("settings.tasks.result.problem") }
}

function resultMark(language: { t: (key: string) => string }, run: Task.Run) {
  const result = runResult(language, run)
  return (
    <span class="inline-flex items-center gap-1.5">
      <span
        class="size-1.5 shrink-0 rounded-full"
        classList={{ "bg-icon-success-base": result.ok, "bg-icon-critical-base": !result.ok }}
      />
      <span classList={{ "text-v2-text-text-base": result.ok, "text-v2-state-fg-danger": !result.ok }}>
        {result.label}
      </span>
    </span>
  )
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
      <Dialog fit>
        <DialogHeader>
          <DialogTitle>{language.t("dialog.tasks.delete.confirm.title")}</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-4 px-5 pb-4">
          <span class="text-[13px] text-v2-text-text-base">
            {language.t("dialog.tasks.delete.confirm.message", { name: task.name })}
          </span>
          <div class="flex justify-end gap-2">
            <ButtonV2 variant="ghost-muted" size="small" onClick={() => dialog.close()}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2
              variant="danger"
              size="small"
              disabled={removeMutation.isPending && removeMutation.variables === task}
              onClick={() => {
                dialog.close()
                removeMutation.mutate(task)
              }}
            >
              {language.t("common.delete")}
            </ButtonV2>
          </div>
        </div>
      </Dialog>
    ))
  }

  const agentOptions = () => [
    { value: "", label: language.t("dialog.tasks.form.agent.default") },
    ...(agentsQuery.data ?? [])
      .filter((agent) => !agent.hidden)
      .map((agent) => ({ value: agent.name, label: agent.name })),
  ]

  const directoryFilterOptions = () => [
    { value: "all", label: language.t("settings.tasks.directory.all") },
    ...directories().map((item) => ({ value: item, label: item })),
  ]

  return (
    <Show
      when={view.mode === "list"}
      fallback={<TaskForm task={view.task} api={api} agents={agentOptions()} onDone={closeForm} />}
    >
      <div class="settings-v2-tab-header">
        <div class="flex items-center justify-between gap-4">
          <h2 class="settings-v2-tab-title">{language.t("settings.tasks.tab")}</h2>
          <ButtonV2 size="small" onClick={openCreate}>
            {language.t("dialog.tasks.new")}
          </ButtonV2>
        </div>
        <p class="m-0 mt-2 text-[13px] leading-5 text-v2-text-text-muted">{language.t("settings.tasks.description")}</p>
      </div>

      <div class="settings-v2-tab-body">
        <section class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.tasks.recent")}</h3>
          <Show
            when={!recentRuns.loading}
            fallback={
              <div class="settings-v2-models-status">
                {language.t("common.loading")}
                {language.t("common.loading.ellipsis")}
              </div>
            }
          >
            <Show
              when={(recentRuns.latest ?? []).length > 0}
              fallback={<div class="settings-v2-models-status">{language.t("dialog.tasks.run.history.empty")}</div>}
            >
              <SettingsListV2>
                <For each={recentRuns.latest ?? []}>
                  {(entry) => {
                    const meta = () =>
                      [
                        language.t(RUN_TRIGGER_KEYS[entry.run.trigger]),
                        formatTime(entry.run.timeCompleted ?? entry.run.scheduledAt),
                        formatDuration(entry.run.timeStarted, entry.run.timeCompleted),
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    return (
                      <SettingsRowV2
                        title={
                          <span class="flex items-center gap-2">
                            {resultMark(language, entry.run)}
                            <span>{entry.task.name}</span>
                          </span>
                        }
                        description={
                          <>
                            <div>{[entry.task.directory, meta()].filter(Boolean).join(" · ")}</div>
                            <Show when={entry.run.error}>
                              <div class="text-v2-state-fg-danger">{entry.run.error}</div>
                            </Show>
                          </>
                        }
                      >
                        <Show when={entry.run.sessionID}>
                          {(sessionID) => (
                            <ButtonV2
                              variant="ghost-muted"
                              size="small"
                              onClick={() => openSession(entry.task.directory, sessionID())}
                            >
                              {language.t("dialog.tasks.run.session", { id: sessionID() })}
                            </ButtonV2>
                          )}
                        </Show>
                      </SettingsRowV2>
                    )
                  }}
                </For>
              </SettingsListV2>
            </Show>
          </Show>
        </section>

        <section class="settings-v2-section">
          <div class="settings-v2-models-group-header justify-between">
            <h3 class="settings-v2-section-title">{language.t("dialog.tasks.title")}</h3>
            <Show when={directories().length > 0}>
              <SelectV2
                appearance="inline"
                options={directoryFilterOptions()}
                current={directoryFilterOptions().find((option) => option.value === directoryFilter())}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => setDirectoryFilter(option?.value ?? "all")}
                placement="bottom-end"
                gutter={6}
              />
            </Show>
          </div>
          <Show
            when={!tasksQuery.isLoading}
            fallback={<div class="settings-v2-models-status">{language.t("common.loading")}</div>}
          >
            <Show
              when={!tasksQuery.error}
              fallback={
                <div class="settings-v2-models-status">
                  {errorMessage(tasksQuery.error) ?? language.t("common.requestFailed")}
                  <ButtonV2 variant="ghost-muted" size="small" onClick={() => void tasksQuery.refetch()}>
                    {language.t("common.retry")}
                  </ButtonV2>
                </div>
              }
            >
              <Show
                when={visibleTasks().length > 0}
                fallback={<div class="settings-v2-models-status">{language.t("dialog.tasks.empty")}</div>}
              >
                <SettingsListV2>
                  <For each={visibleTasks()}>
                    {(task) => (
                      <div data-component="settings-v2-row">
                        <div data-slot="settings-v2-row-copy" class="gap-2">
                          <button
                            type="button"
                            class="flex items-center gap-2 text-left"
                            onClick={() => setExpanded(expanded() === task.id ? undefined : task.id)}
                          >
                            <IconV2
                              name="chevron-down"
                              size="small"
                              class="text-v2-icon-icon-muted"
                              classList={{ "-rotate-90": expanded() !== task.id }}
                            />
                            <span data-slot="settings-v2-row-title" class="shrink-0 whitespace-nowrap">{task.name}</span>
                            <Show when={task.description}>
                              <span class="text-[13px] font-normal text-v2-text-text-muted">{task.description}</span>
                            </Show>
                          </button>
                          <div data-slot="settings-v2-row-description">
                            {[
                              task.directory,
                              language.t("dialog.tasks.cron", { cron: task.cron }),
                              task.timezone ?? "",
                              task.agent ? `${language.t("dialog.tasks.form.agent")}: ${task.agent}` : "",
                              task.enabled && task.nextRunAt
                                ? language.t("dialog.tasks.nextRun", { time: formatTime(task.nextRunAt) ?? "" })
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                          <div class="flex items-center gap-2 pt-1">
                            <ButtonV2
                              size="small"
                              onClick={() => triggerMutation.mutate(task)}
                              disabled={
                                activeRuns[task.id] ||
                                (triggerMutation.isPending && triggerMutation.variables === task)
                              }
                            >
                              {language.t("dialog.tasks.run.now")}
                            </ButtonV2>
                            <ButtonV2 size="small" variant="ghost-muted" onClick={() => openEdit(task)}>
                              {language.t("common.edit")}
                            </ButtonV2>
                            <ButtonV2 size="small" variant="ghost-muted" onClick={() => confirmRemove(task)}>
                              {language.t("common.delete")}
                            </ButtonV2>
                          </div>
                          <Show when={expanded() === task.id}>
                            <Show
                              when={!runs.loading}
                              fallback={
                                <span class="text-[13px] text-v2-text-text-muted">
                                  {language.t("common.loading")}
                                  {language.t("common.loading.ellipsis")}
                                </span>
                              }
                            >
                              <Show
                                when={!runs.error}
                                fallback={
                                  <div class="settings-v2-models-status">
                                    {language.t("common.requestFailed")}
                                    <ButtonV2
                                      variant="ghost-muted"
                                      size="small"
                                      onClick={() => void runsActions.refetch()}
                                    >
                                      {language.t("common.retry")}
                                    </ButtonV2>
                                  </div>
                                }
                              >
                                <Show
                                  when={(runs.latest ?? []).length > 0}
                                  fallback={
                                    <div class="settings-v2-models-status">
                                      {language.t("dialog.tasks.run.history.empty")}
                                    </div>
                                  }
                                >
                                  <div class="flex flex-col pt-1">
                                    <For each={runs.latest ?? []}>
                                      {(run) => {
                                        const meta = () =>
                                          [
                                            language.t(RUN_TRIGGER_KEYS[run.trigger]),
                                            formatTime(run.scheduledAt),
                                            formatDuration(run.timeStarted, run.timeCompleted),
                                          ]
                                            .filter(Boolean)
                                            .join(" · ")
                                        return (
                                          <div class="flex items-center justify-between gap-3 py-1.5 text-[13px] font-normal">
                                            <div class="flex min-w-0 flex-col gap-0.5">
                                              <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-v2-text-text-muted">
                                                {resultMark(language, run)}
                                                <span>{meta()}</span>
                                              </div>
                                              <Show when={run.error}>
                                                <span class="text-v2-state-fg-danger">{run.error}</span>
                                              </Show>
                                            </div>
                                            <Show when={run.sessionID}>
                                              {(sessionID) => (
                                                <ButtonV2
                                                  variant="ghost-muted"
                                                  size="small"
                                                  class="max-w-[45%] truncate font-mono"
                                                  onClick={() => openSession(task.directory, sessionID())}
                                                >
                                                  {language.t("dialog.tasks.run.session", { id: sessionID() })}
                                                </ButtonV2>
                                              )}
                                            </Show>
                                          </div>
                                        )
                                      }}
                                    </For>
                                  </div>
                                </Show>
                              </Show>
                            </Show>
                          </Show>
                        </div>
                        <div data-slot="settings-v2-row-control" class="self-start">
                          <Switch
                            checked={task.enabled}
                            disabled={toggleMutation.isPending && toggleMutation.variables?.task.id === task.id}
                            onChange={(checked) => toggleMutation.mutate({ task, enabled: checked })}
                            hideLabel
                          >
                            {task.name}
                          </Switch>
                        </div>
                      </div>
                    )}
                  </For>
                </SettingsListV2>
              </Show>
            </Show>
          </Show>
        </section>
      </div>
    </Show>
  )
}

function SettingsTasksRemove(props: {
  task: Task.Info
  pending: boolean
  onCancel: () => void
  onConfirm: (task: Task.Info) => void
}) {
  const language = useLanguage()
  return (
    <Dialog fit>
      <DialogHeader>
        <DialogTitle>{language.t("dialog.tasks.delete.confirm.title")}</DialogTitle>
      </DialogHeader>
      <div class="flex flex-col gap-4 px-5 pb-4">
        <span class="text-[13px] text-v2-text-text-base">
          {language.t("dialog.tasks.delete.confirm.message", { name: props.task.name })}
        </span>
        <div class="flex justify-end gap-2">
          <ButtonV2 variant="ghost-muted" size="small" onClick={() => props.onCancel()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 variant="danger" size="small" disabled={props.pending} onClick={() => props.onConfirm(props.task)}>
            {language.t("common.delete")}
          </ButtonV2>
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
  onDone: () => void
}) {
  const language = useLanguage()
  const [form, setForm] = createStore<TaskFormState>(formState(props.task))
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
  const cronInvalid = () =>
    !checkResult.loading && cronCheck() !== undefined && (checkResult.latest?.next?.length ?? 0) === 0
  const formatTime = (value: number | undefined) => {
    if (!value) return
    return DateTime.fromMillis(value).setLocale(language.intl()).toLocaleString(DateTime.DATETIME_MED)
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <div class="settings-v2-tab-header-row">
          <div class="flex items-center gap-2">
            <IconButtonV2
              variant="ghost-muted"
              size="small"
              aria-label={language.t("common.cancel")}
              onClick={props.onDone}
              icon={
                <IconV2 name="chevron-down" class="rotate-90 text-v2-icon-icon-muted" />
              }
            />
            <h2 class="settings-v2-tab-title">
              {props.task ? language.t("dialog.tasks.form.edit.title") : language.t("dialog.tasks.new")}
            </h2>
          </div>
        </div>
      </div>
      <div class="settings-v2-tab-body">
        <form class="settings-v2-section max-w-[560px]" onSubmit={submit}>
          <Field>
            <Field.Label>{language.t("dialog.tasks.form.name")}</Field.Label>
            <TextInputV2
              autofocus
              appearance="large"
              class="!w-full"
              value={form.name}
              placeholder={language.t("dialog.tasks.form.name.placeholder")}
              onInput={(event) => setField("name", event.currentTarget.value)}
              invalid={!!form.errors.name}
            />
          </Field>
          <div class="grid grid-cols-2 gap-4">
            <Field invalid={!!form.errors.cron || cronInvalid()}>
              <Field.Label>{language.t("dialog.tasks.form.cron")}</Field.Label>
              <TextInputV2
                appearance="large"
                class="!w-full"
                value={form.cron}
                placeholder={language.t("dialog.tasks.form.cron.placeholder")}
                onInput={(event) => setField("cron", event.currentTarget.value)}
                onBlur={checkCron}
              />
            </Field>
            <Field>
              <Field.Label>{language.t("dialog.tasks.form.timezone")}</Field.Label>
              <TextInputV2
                appearance="large"
                class="!w-full"
                value={form.timezone}
                placeholder={language.t("dialog.tasks.form.timezone.placeholder")}
                onInput={(event) => setField("timezone", event.currentTarget.value)}
                onBlur={checkCron}
              />
            </Field>
          </div>
          <Show when={cronCheck() && (checkResult.loading || nextFire() || cronInvalid())}>
            <span
              class="text-[13px]"
              classList={{
                "text-v2-text-text-muted": !cronInvalid(),
                "text-v2-state-fg-danger": cronInvalid(),
              }}
            >
              {checkResult.loading
                ? language.t("settings.tasks.form.cron.checking")
                : cronInvalid()
                  ? language.t("settings.tasks.form.cron.invalid")
                  : `${language.t("settings.tasks.form.cron.next")} ${formatTime(nextFire())}`}
            </span>
          </Show>
          <div class="grid grid-cols-2 gap-4">
            <Field>
              <Field.Label>{language.t("dialog.tasks.form.model")}</Field.Label>
              <TextInputV2
                appearance="large"
                class="!w-full"
                value={form.model}
                placeholder={language.t("dialog.tasks.form.model.placeholder")}
                onInput={(event) => setField("model", event.currentTarget.value)}
              />
            </Field>
            <Show
              when={props.task}
              fallback={
                <Field>
                  <Field.Label>{language.t("settings.tasks.form.directory")}</Field.Label>
                  <TextInputV2
                    appearance="large"
                    class="!w-full"
                    value={form.directory}
                    placeholder={language.t("settings.tasks.form.directory.placeholder")}
                    onInput={(event) => setField("directory", event.currentTarget.value)}
                  />
                </Field>
              }
            >
              <Field>
                <Field.Label>{language.t("settings.tasks.form.directory")}</Field.Label>
                <TextInputV2 appearance="large" class="!w-full" value={props.task?.directory ?? ""} disabled />
              </Field>
            </Show>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <Field>
              <Field.Label>{language.t("dialog.tasks.form.timeout")}</Field.Label>
              <TextInputV2
                numeric
                appearance="large"
                class="!w-full"
                value={form.runTimeoutMs}
                onInput={(event) => setField("runTimeoutMs", event.currentTarget.value)}
              />
            </Field>
            <Field>
              <Field.Label>{language.t("dialog.tasks.form.retain")}</Field.Label>
              <TextInputV2
                numeric
                appearance="large"
                class="!w-full"
                value={form.retainRuns}
                onInput={(event) => setField("retainRuns", event.currentTarget.value)}
              />
            </Field>
          </div>
          <Field>
            <Field.Label>{language.t("dialog.tasks.form.agent")}</Field.Label>
            <SelectV2
              appearance="inline"
              options={agentOptions()}
              current={agentOptions().find((option) => option.value === form.agent) ?? agentOptions()[0]}
              value={(option) => option.value}
              label={(option) => option.label}
              onSelect={(option) => setField("agent", option?.value ?? "")}
              placement="bottom-start"
              gutter={6}
            />
            <span class="text-[12px] text-v2-text-text-muted">{language.t("dialog.tasks.form.agent.hint")}</span>
          </Field>
          <Field>
            <Field.Label>{language.t("dialog.tasks.form.description")}</Field.Label>
            <TextInputV2
              appearance="large"
              class="!w-full"
              value={form.description}
              placeholder={language.t("dialog.tasks.form.description.placeholder")}
              onInput={(event) => setField("description", event.currentTarget.value)}
            />
          </Field>
          <Field>
            <Field.Label>{language.t("dialog.tasks.form.prompt")}</Field.Label>
            <textarea
              class="settings-v2-tasks-prompt"
              value={form.prompt}
              placeholder={language.t("dialog.tasks.form.prompt.placeholder")}
              onInput={(event) => setField("prompt", event.currentTarget.value)}
              rows={6}
            />
          </Field>
          <Switch checked={form.enabled} onChange={(checked) => setEnabled(checked)}>
            {language.t("dialog.tasks.form.enabled")}
          </Switch>
          <Show when={form.errors.submit}>
            <span class="text-[13px] text-v2-state-fg-danger">{form.errors.submit}</span>
          </Show>
          <div class="flex justify-end gap-2">
            <ButtonV2 type="button" variant="ghost-muted" size="small" onClick={props.onDone}>
              {language.t("common.cancel")}
            </ButtonV2>
            <ButtonV2 type="submit" size="small" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? language.t("common.saving") : language.t("common.save")}
            </ButtonV2>
          </div>
        </form>
      </div>
    </>
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
