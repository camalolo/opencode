import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Switch as SwitchV2 } from "@opencode-ai/ui/v2/switch-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { For, Show, createMemo, type Component } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]
type ModelGroup = { category: string; items: ModelItem[] }

// The grouped provider/model list shared by the manage-models dialog and the
// settings models tab: a provider switch collapses the group and hides all of
// its models, and every model with effort levels gets a per-model thinking
// effort select.
export const ModelsProviderGroups: Component<{
  groups: ModelGroup[]
  searching?: () => boolean
}> = (props) => {
  const models = useModels()
  const language = useLanguage()
  const [revealed, setRevealed] = createStore({} as Record<string, boolean>)

  const providerActive = (group: ModelGroup) =>
    group.items.some((item) => models.visible({ providerID: item.provider.id, modelID: item.id }))
  const setProviderVisibility = (group: ModelGroup, checked: boolean) => {
    group.items.forEach((item) => {
      models.setVisibility({ providerID: item.provider.id, modelID: item.id }, checked)
    })
  }

  return (
    <For each={props.groups}>
      {(group) => {
        const expanded = () => !!props.searching?.() || providerActive(group) || !!revealed[group.category]
        return (
          <div
            class="settings-v2-section"
            data-component="settings-models-provider"
            data-expanded={expanded() ? "" : undefined}
          >
            <div class="settings-v2-models-group-header justify-between">
              <div class="flex min-w-0 items-center gap-2">
                <ProviderIcon id={group.category} width={16} height={16} class="ml-4 shrink-0" />
                <h3 class="settings-v2-section-title">{group.items[0].provider.name}</h3>
              </div>
              <div>
                <SwitchV2
                  class="mr-6"
                  checked={expanded()}
                  onChange={(checked) => {
                    if (checked) {
                      setRevealed(group.category, true)
                      return
                    }
                    setRevealed(group.category, false)
                    setProviderVisibility(group, false)
                  }}
                  hideLabel
                >
                  {group.items[0].provider.name}
                </SwitchV2>
              </div>
            </div>
            <Show when={expanded()}>
              <SettingsListV2>
                <For each={group.items}>{(item) => <ModelRow item={item} models={models} language={language} />}</For>
              </SettingsListV2>
            </Show>
          </div>
        )
      }}
    </For>
  )
}

function ModelRow(props: { item: ModelItem; models: ReturnType<typeof useModels>; language: ReturnType<typeof useLanguage> }) {
  const key = () => ({ providerID: props.item.provider.id, modelID: props.item.id })
  return (
    <SettingsRowV2 title={props.item.name} description="">
      <div class="flex items-center gap-2">
        <Show when={modelVariants(props.item).length > 0}>
          <ModelVariantSelect item={props.item} models={props.models} language={props.language} />
        </Show>
        <div>
          <SwitchV2 checked={props.models.visible(key())} onChange={(checked) => props.models.setVisibility(key(), checked)} hideLabel>
            {props.item.name}
          </SwitchV2>
        </div>
      </div>
    </SettingsRowV2>
  )
}

function modelVariants(item: ModelItem) {
  return Object.keys(item.variants ?? {})
}

type VariantOption = { id: string; value?: string }

function ModelVariantSelect(props: {
  item: ModelItem
  models: ReturnType<typeof useModels>
  language: ReturnType<typeof useLanguage>
}) {
  const options = createMemo<VariantOption[]>(() => [
    { id: "default" },
    ...modelVariants(props.item).map((value) => ({ id: value, value })),
  ])
  const current = () => {
    const saved = props.models.variant.get({ providerID: props.item.provider.id, modelID: props.item.id })
    return options().find((option) => option.value === saved) ?? options()[0]
  }
  const label = (option: VariantOption) =>
    option.value ? option.value.charAt(0).toUpperCase() + option.value.slice(1) : props.language.t("common.default")
  return (
    <TooltipV2 value={props.language.t("dialog.model.manage.reasoning")} placement="bottom" gutter={6}>
      <SelectV2
        appearance="inline"
        data-action="manage-models-reasoning"
        options={options()}
        current={current()}
        value={(option) => option.id}
        label={label}
        onSelect={(option) =>
          props.models.variant.set({ providerID: props.item.provider.id, modelID: props.item.id }, option?.value)
        }
        placement="bottom-end"
        gutter={6}
      />
    </TooltipV2>
  )
}
