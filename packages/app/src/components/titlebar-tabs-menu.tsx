import { Popover as Kobalte } from "@kobalte/core/popover"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { tabKey, type Tab } from "@/context/tabs"
import { projectForSession } from "@/pages/layout/helpers"
import { SessionTabAvatar } from "@/pages/layout/session-tab-avatar"
import { sleepPhase, sleepTooltip, sleepingStatus, useNow } from "@/utils/sleep-stall"

// Touch-first replacement for the cramped desktop tab strip: a full list of
// open tabs with roomy rows, so switching and closing stays reachable on a
// phone. Rendered only on narrow viewports by the titlebar.
export function TitlebarTabsMenu(props: {
  tabs: Tab[]
  current: () => Tab | undefined
  label: string
  onNavigate: (tab: Tab) => void
  onClose: (tab: Tab) => void
}) {
  const [open, setOpen] = createSignal(false)
  const currentKey = () => {
    const current = props.current()
    return current ? tabKey(current) : undefined
  }

  return (
    <Kobalte open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={6}>
      <Kobalte.Trigger
        as={IconButtonV2}
        type="button"
        variant="ghost-muted"
        size="large"
        class="shrink-0 max-md:!size-10"
        icon={<IconV2 name="workspace" />}
        aria-label={props.label}
        aria-expanded={open()}
      />
      <Kobalte.Portal>
        <Kobalte.Content
          ref={(el) => {
            const theme = document.querySelector('[data-slot="titlebar-v2"]')?.closest("[data-theme]")
            const value = theme?.getAttribute("data-theme")
            if (value) el.setAttribute("data-theme", value)
          }}
          data-component="titlebar-tabs-menu"
          class="z-50 w-[min(340px,calc(100vw-16px))] overflow-hidden rounded-[10px] bg-v2-background-bg-base p-1.5 shadow-[var(--v2-elevation-raised)] outline-none"
        >
          <div class="flex max-h-[60vh] flex-col overflow-y-auto no-scrollbar">
            <For each={props.tabs}>
              {(tab) => (
                <TabsMenuRow
                  tab={tab}
                  active={currentKey() === tabKey(tab)}
                  onNavigate={() => {
                    setOpen(false)
                    props.onNavigate(tab)
                  }}
                  onClose={() => props.onClose(tab)}
                />
              )}
            </For>
          </div>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}

// The desktop strip resolves titles from the live session sync, not from the
// persisted tab info record (which is only a stale-data fallback).
function TabsMenuRow(props: { tab: Tab; active: boolean; onNavigate: () => void; onClose: () => void }) {
  const global = useGlobal()
  const language = useLanguage()
  const closeLabel = language.t("common.closeTab")

  const serverCtx = createMemo(() => {
    if (props.tab.type !== "session") return
    const conn = global.servers.list().find((item) => ServerConnection.key(item) === props.tab.server)
    if (conn) return global.ensureServerCtx(conn)
  })
  const cached = createMemo(() => {
    if (props.tab.type !== "session") return
    return serverCtx()?.sync.session.peek(props.tab.sessionId)
  })
  const [loaded] = createResource(
    () => {
      if (props.tab.type !== "session") return null
      const ctx = serverCtx()
      return ctx ? { id: props.tab.sessionId, ctx } : null
    },
    ({ id, ctx }) => ctx.sync.session.resolve(id).catch(() => undefined),
  )
  const title = createMemo(() => {
    if (props.tab.type === "draft") return language.t("command.session.new")
    return (
      cached()?.title ?? loaded()?.title ?? (loaded.loading ? "" : language.t("session.tab.unknown"))
    )
  })
  const session = createMemo(() => cached() ?? loaded())
  const project = createMemo(() => {
    const value = session()
    if (!value) return
    return projectForSession(value, serverCtx()?.projects.list() ?? [])
  })

  return (
    <div
      class="group flex h-11 shrink-0 items-center gap-1 rounded-md pl-2"
      classList={{ "bg-v2-overlay-simple-overlay-hover": props.active }}
    >
      <button
        type="button"
        class="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-start text-[13px] font-medium text-v2-text-text-muted hover:text-v2-text-text-base"
        onClick={props.onNavigate}
      >
        <span data-slot="project-avatar-slot" class="relative flex size-4 shrink-0 items-center justify-center">
          <Show
            when={props.tab.type === "session" ? session() : undefined}
            keyed
            fallback={<span class="block size-4 rounded-[3px] border border-v2-border-border-muted" aria-hidden="true" />}
          >
            {(value) => (
              <>
                <SessionTabAvatar
                  project={project()}
                  directory={value.directory}
                  sessionId={value.id}
                  server={props.tab.server}
                />
                <Show
                  when={sleepingStatus(serverCtx()?.sync.session.data.session_status[value.id])}
                  keyed
                >
                  {(status) => {
                    const now = useNow()
                    const phase = createMemo(() => sleepPhase(status, now()))
                    return (
                      <span
                        class={`absolute -bottom-0.5 -end-0.5 flex size-3 items-center justify-center rounded-full ring-1 ring-v2-background-background-base ${
                          phase() === "stalled"
                            ? "bg-surface-warning-strong animate-pulse"
                            : phase() === "near"
                              ? "bg-surface-warning-strong"
                              : "bg-text-diff-delete-base"
                        }`}
                        title={sleepTooltip(status, now(), language.t)}
                        data-slot="tab-sleeping-indicator"
                        data-phase={phase()}
                        data-stalled={phase() === "stalled" ? "true" : undefined}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="white"
                          stroke-width="2.5"
                          class="size-2"
                          aria-hidden="true"
                        >
                          <circle cx="12" cy="12" r="9" />
                          <path d="M12 7v5l3 2" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                      </span>
                    )
                  }}
                </Show>
              </>
            )}
          </Show>
        </span>
        <span class="truncate">{title()}</span>
      </button>
      <Show when={props.active}>
        <IconV2 name="check" class="shrink-0 text-v2-icon-icon-muted" />
      </Show>
      <IconButtonV2
        size="large"
        variant="ghost-muted"
        class="!size-9 shrink-0"
        onClick={(event: MouseEvent) => {
          event.stopPropagation()
          props.onClose()
        }}
        icon={<IconV2 name="xmark-small" />}
        aria-label={`${closeLabel}: ${title()}`}
      />
    </div>
  )
}
