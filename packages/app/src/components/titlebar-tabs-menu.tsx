import { Popover as Kobalte } from "@kobalte/core/popover"
import { createMemo, createSignal, For, Show } from "solid-js"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import { tabKey, type Tab, type TabInfo } from "@/context/tabs"

// Touch-first replacement for the cramped desktop tab strip: a full list of
// open tabs with roomy rows, so switching and closing stays reachable on a
// phone. Rendered only on narrow viewports by the titlebar.
export function TitlebarTabsMenu(props: {
  tabs: Tab[]
  info: Record<string, TabInfo>
  current: () => Tab | undefined
  label: string
  onNavigate: (tab: Tab) => void
  onClose: (tab: Tab) => void
}) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const closeLabel = language.t("common.closeTab")
  const currentKey = () => {
    const current = props.current()
    return current ? tabKey(current) : undefined
  }

  const rows = createMemo(() =>
    props.tabs.map((tab) => ({
      tab,
      key: tabKey(tab),
      title: tab.type === "draft" ? language.t("command.session.new") : (props.info[tabKey(tab)]?.title ?? language.t("session.tab.unknown")),
    })),
  )

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
            <For each={rows()}>
              {(row) => (
                <div
                  class="group flex h-11 shrink-0 items-center gap-1 rounded-md pl-2"
                  classList={{ "bg-v2-overlay-simple-overlay-hover": currentKey() === row.key }}
                >
                  <button
                    type="button"
                    class="flex h-full min-w-0 flex-1 items-center gap-2 rounded-md text-start text-[13px] font-medium text-v2-text-text-muted hover:text-v2-text-text-base"
                    onClick={() => {
                      setOpen(false)
                      props.onNavigate(row.tab)
                    }}
                  >
                    <span class="truncate">{row.title}</span>
                  </button>
                  <Show when={currentKey() === row.key}>
                    <IconV2 name="check" class="shrink-0 text-v2-icon-icon-muted" />
                  </Show>
                  <IconButtonV2
                    size="large"
                    variant="ghost-muted"
                    class="!size-9 shrink-0"
                    onClick={(event: MouseEvent) => {
                      event.stopPropagation()
                      props.onClose(row.tab)
                    }}
                    icon={<IconV2 name="xmark-small" />}
                    aria-label={`${closeLabel}: ${row.title}`}
                  />
                </div>
              )}
            </For>
          </div>
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
