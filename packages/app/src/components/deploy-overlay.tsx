import { Splash } from "@opencode-ai/ui/logo"
import { For, Show, createSignal, onCleanup } from "solid-js"
import { DEPLOY_PHASES, useDeploy, type DeployPhase } from "@/context/deploy"
import { useLanguage } from "@/context/language"

const PHASE_LABEL_KEYS: Record<DeployPhase, Parameters<ReturnType<typeof useLanguage>["t"]>[0]> = {
  restore: "deploy.ongoing.phase.restore",
  pull: "deploy.ongoing.phase.pull",
  install: "deploy.ongoing.phase.install",
  build: "deploy.ongoing.phase.build",
  manifest: "deploy.ongoing.phase.manifest",
  drain: "deploy.ongoing.phase.drain",
  restart: "deploy.ongoing.phase.restart",
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
  // The store never holds boot-only phases (the "resume" restore runs in the
  // background unsurfaced), so anything stored is a deploy step or an error.
  const phase = () => (DEPLOY_PHASES as readonly string[]).includes(status()!.phase)
    ? (status()!.phase as DeployPhase)
    : "drain"
  const index = () => DEPLOY_PHASES.indexOf(phase())
  const waiting = () => status()!.down || status()!.phase === "restart"

  return (
    <Show when={status()} keyed>
      {(status) => (
        <div class="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background-base gap-6 p-6">
          <div class="flex flex-col items-center max-w-md text-center gap-1">
            <Splash class="w-12 h-15 mb-4 animate-pulse" />
            <Show
              when={status.error}
              fallback={
                <>
                  <p class="text-14-regular text-text-strong font-medium">{language.t("deploy.ongoing.title")}</p>
                  <p class="text-12-regular text-text-base mt-1">
                    {waiting() ? language.t("deploy.ongoing.down") : language.t(PHASE_LABEL_KEYS[phase()])}
                  </p>
                  <div
                    class="flex gap-1.5 w-full max-w-sm mt-4"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={DEPLOY_PHASES.length}
                    aria-valuenow={index() + 1}
                  >
                    <For each={DEPLOY_PHASES}>
                      {(_, segment) => (
                        <div
                          class="h-1 flex-1 rounded-full transition-colors duration-500"
                          classList={{
                            "bg-text-strong": segment() === index(),
                            "bg-text-weak": segment() < index(),
                            "bg-surface-inset-base": segment() > index(),
                          }}
                        />
                      )}
                    </For>
                  </div>
                  <Show when={phase() === "drain" && (status.activeSessions?.length ?? 0) > 0}>
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
                </>
              }
            >
              <p class="text-14-regular text-text-strong font-medium">{language.t("deploy.failed.title")}</p>
              <p class="text-12-regular text-text-weak mt-2 break-words max-w-md">{status.error}</p>
              <button
                type="button"
                class="mt-4 px-3 py-2 rounded-md bg-surface-base hover:bg-surface-raised-base-hover transition-colors text-14-regular text-text-base"
                onClick={() => deploy.dismiss()}
              >
                {language.t("deploy.failed.dismiss")}
              </button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}
