import { Splash } from "@opencode-ai/ui/logo"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { DEPLOY_PHASES, useDeploy, type DeployPhase } from "@/context/deploy"
import { useLanguage } from "@/context/language"

const PHASE_LABEL_KEYS: Record<DeployPhase, Parameters<ReturnType<typeof useLanguage>["t"]>[0]> = {
  pull: "deploy.ongoing.phase.pull",
  install: "deploy.ongoing.phase.install",
  build: "deploy.ongoing.phase.build",
  manifest: "deploy.ongoing.phase.manifest",
  drain: "deploy.ongoing.phase.drain",
  restart: "deploy.ongoing.phase.restart",
  resume: "deploy.ongoing.phase.resume",
}

function Elapsed(props: { startedAt?: number }) {
  const [now, setNow] = createSignal(Date.now())
  const id = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(id))

  const elapsed = () => {
    if (!props.startedAt) return undefined
    const seconds = Math.max(0, Math.floor((now() - props.startedAt) / 1000))
    const minutes = Math.floor(seconds / 60)
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`
  }

  return (
    <Show when={elapsed()}>
      {(value) => <p class="text-12-regular text-text-weak tabular-nums">{value()}</p>}
    </Show>
  )
}

export function DeployOverlay() {
  const deploy = useDeploy()
  const language = useLanguage()
  const status = () => deploy.current()

  return (
    <Show when={status()} keyed>
      {(status) => (
        <Show
          when={status.error}
          keyed
          fallback={
            <Show
              when={status.phase !== "resume"}
              fallback={
                // Boot resume keeps the app usable: it can legitimately run
                // for many minutes while interrupted turns restore, so it
                // reports through a small corner card instead of the splash.
                <div class="fixed bottom-4 right-4 z-[9999] flex flex-col gap-1 rounded-md border border-border-weak-base bg-surface-panel p-3 shadow-md">
                  <p class="text-14-regular text-text-strong font-medium">
                    {language.t(PHASE_LABEL_KEYS.resume)}
                  </p>
                  <Show when={(status.activeSessions?.length ?? 0) > 0}>
                    <p class="text-12-regular text-text-weak">
                      {language.plural("deploy.ongoing.resume.active", status.activeSessions!.length)}
                    </p>
                  </Show>
                  <div class="flex items-center gap-3 mt-1">
                    <Elapsed startedAt={status.startedAt} />
                    <button
                      type="button"
                      class="px-2 py-1 rounded-md bg-surface-base hover:bg-surface-raised-base-hover transition-colors text-12-regular text-text-base"
                      onClick={() => deploy.dismiss()}
                    >
                      {language.t("deploy.ongoing.dismiss")}
                    </button>
                  </div>
                </div>
              }
            >
              <div class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background-base gap-6 p-6">
                <div class="flex flex-col items-center max-w-md text-center gap-1">
                  <Splash class="w-12 h-15 mb-4 animate-pulse" />
                  <p class="text-14-regular text-text-strong font-medium">{language.t("deploy.ongoing.title")}</p>
                  <p class="text-12-regular text-text-base mt-1">
                    {status.down || status.phase === "restart"
                      ? language.t("deploy.ongoing.down")
                      : language.t(PHASE_LABEL_KEYS[status.phase as DeployPhase] ?? "deploy.ongoing.phase.drain")}
                  </p>
                  <div
                    class="flex gap-1.5 w-full max-w-sm mt-4"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={DEPLOY_PHASES.length}
                    aria-valuenow={DEPLOY_PHASES.indexOf(status.phase as DeployPhase) + 1}
                  >
                    <For each={DEPLOY_PHASES}>
                      {(_, segment) => (
                        <div
                          class="h-1 flex-1 rounded-full transition-colors duration-500"
                          classList={{
                            "bg-text-strong": segment() === DEPLOY_PHASES.indexOf(status.phase as DeployPhase),
                            "bg-text-weak": segment() < DEPLOY_PHASES.indexOf(status.phase as DeployPhase),
                            "bg-surface-inset-base": segment() > DEPLOY_PHASES.indexOf(status.phase as DeployPhase),
                          }}
                        />
                      )}
                    </For>
                  </div>
                  <Show when={status.phase === "drain" && (status.activeSessions?.length ?? 0) > 0}>
                    <p class="text-12-regular text-text-weak mt-2">
                      {language.plural("deploy.ongoing.drain.active", status.activeSessions!.length)}
                    </p>
                  </Show>
                  <Elapsed startedAt={status.startedAt} />
                  <button
                    type="button"
                    class="mt-4 px-3 py-2 rounded-md bg-surface-base hover:bg-surface-raised-base-hover transition-colors text-14-regular text-text-base"
                    onClick={() => deploy.dismiss()}
                  >
                    {language.t("deploy.failed.dismiss")}
                  </button>
                </div>
              </div>
            </Show>
          }
        >
          <div class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background-base gap-6 p-6">
            <div class="flex flex-col items-center max-w-md text-center gap-1">
              <Splash class="w-12 h-15 mb-4 animate-pulse" />
              <p class="text-14-regular text-text-strong font-medium">{language.t("deploy.failed.title")}</p>
              <p class="text-12-regular text-text-weak mt-2 break-words max-w-md">{status.error}</p>
              <button
                type="button"
                class="mt-4 px-3 py-2 rounded-md bg-surface-base hover:bg-surface-raised-base-hover transition-colors text-14-regular text-text-base"
                onClick={() => deploy.dismiss()}
              >
                {language.t("deploy.failed.dismiss")}
              </button>
            </div>
          </div>
        </Show>
      )}
    </Show>
  )
}
