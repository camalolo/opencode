import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { createStore } from "solid-js/store"
import { createResource, type Component, For, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

// IDs match the `websearch-<provider>` entries the bundled search-mcp server
// reads from the auth store (tools/search-mcp/src/providers.ts).
const SEARCH_KEYS = [
  {
    id: "websearch-tavily",
    titleKey: "settings.websearch.key.tavily.title",
    descriptionKey: "settings.websearch.key.tavily.description",
  },
  {
    id: "websearch-exa",
    titleKey: "settings.websearch.key.exa.title",
    descriptionKey: "settings.websearch.key.exa.description",
  },
  {
    id: "websearch-tinyfish",
    titleKey: "settings.websearch.key.tinyfish.title",
    descriptionKey: "settings.websearch.key.tinyfish.description",
  },
] as const

export const SettingsWebSearchV2: Component = () => {
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const [values, setValues] = createStore<Record<string, string>>({})

  const [auth, authActions] = createResource(async () => {
    const response = await serverSdk().client.auth.list()
    return response.data
  })

  const configured = (id: string) => auth.latest?.[id]?.type !== undefined

  const fail = (err: unknown) => {
    showToast({
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })
  }

  const save = async (id: string) => {
    const key = values[id]?.trim()
    if (!key) return
    try {
      await serverSdk().client.auth.set({ providerID: id, auth: { type: "api", key } })
      setValues(id, "")
      void authActions.refetch()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.websearch.toast.saved.title"),
        description: language.t("settings.websearch.toast.saved.description"),
      })
    } catch (err) {
      fail(err)
    }
  }

  const remove = async (id: string) => {
    try {
      await serverSdk().client.auth.remove({ providerID: id })
      void authActions.refetch()
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.websearch.toast.removed.title"),
        description: language.t("settings.websearch.toast.removed.description"),
      })
    } catch (err) {
      fail(err)
    }
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.websearch.title")}</h2>
      </div>

      <div class="settings-v2-tab-body">
        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.websearch.section.keys")}</h3>
          <SettingsListV2>
            <For each={SEARCH_KEYS}>
              {(entry) => (
                <SettingsRowV2 title={language.t(entry.titleKey)} description={language.t(entry.descriptionKey)}>
                  <div class="flex flex-col items-end gap-2">
                    <div class="flex items-center gap-2">
                      <Show
                        when={configured(entry.id)}
                        fallback={<Tag>{language.t("settings.websearch.key.notConfigured")}</Tag>}
                      >
                        <Tag>{language.t("settings.websearch.key.configured")}</Tag>
                      </Show>
                      <Show when={configured(entry.id)}>
                        <ButtonV2 size="normal" variant="ghost-muted" onClick={() => void remove(entry.id)}>
                          {language.t("settings.websearch.key.remove")}
                        </ButtonV2>
                      </Show>
                    </div>
                    <div class="flex items-center gap-2">
                      <TextInputV2
                        type="password"
                        autocomplete="off"
                        placeholder={language.t("settings.websearch.key.placeholder")}
                        value={values[entry.id] ?? ""}
                        onInput={(event) => setValues(entry.id, event.currentTarget.value)}
                      />
                      <ButtonV2
                        size="normal"
                        variant="neutral"
                        disabled={!values[entry.id]?.trim()}
                        onClick={() => void save(entry.id)}
                      >
                        {language.t("common.save")}
                      </ButtonV2>
                    </div>
                  </div>
                </SettingsRowV2>
              )}
            </For>
          </SettingsListV2>
          <p class="settings-v2-provider-description">{language.t("settings.websearch.section.description")}</p>
        </div>
      </div>
    </>
  )
}
