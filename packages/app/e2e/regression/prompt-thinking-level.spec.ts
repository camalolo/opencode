import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectAppVisible } from "../utils/waits"

const directory = "C:/OpenCode/PromptThinkingLevelRegression"
const projectID = "proj_prompt_thinking_level_regression"
const sessionID = "ses_prompt_thinking_level_regression"

test("thinking effort is configured per model in manage models instead of the composer", async ({ page }) => {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "prompt-thinking-level-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "thinking-model": {
              id: "thinking-model",
              name: "Thinking Model",
              limit: { context: 200_000 },
              variants: { high: {} },
            },
          },
        },
        {
          id: "anthropic",
          name: "Anthropic",
          models: {
            "paid-model": {
              id: "paid-model",
              name: "Paid Model",
              limit: { context: 200_000 },
              cost: { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
            },
          },
        },
      ],
      connected: ["opencode", "anthropic"],
      default: { providerID: "opencode", modelID: "thinking-model" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "prompt-thinking-level-regression",
        projectID,
        directory,
        title: "Prompt thinking level regression",
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({ items: [] }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  const composer = page.locator('[data-component="prompt-input-v2"]')
  await expectAppVisible(composer)

  // The app boots the legacy shell first and flips to the new layout once
  // settings resolve; the new-layout toast region only exists after the flip.
  await expect(page.locator("body")).toHaveAttribute("data-new-layout", "")

  await idleComposer(page)
  await expect(composer.getByRole("button", { name: "Choose model variant" })).toHaveCount(0)

  // The model button surfaces the active level so the cycle keybind stays
  // observable, and cycling announces each change with a toast.
  const modelButton = page.locator('[data-action="prompt-model"]')
  await expect(modelButton).not.toHaveAttribute("data-prompt-variant")

  await page.keyboard.press("Shift+Control+d")
  await expect(page.locator('.toast-v2 [data-title]').filter({ hasText: 'Thinking effort: High' })).toBeVisible()
  await expect(modelButton).toHaveAttribute("data-prompt-variant", "high")

  await page.keyboard.press("Shift+Control+d")
  await expect(page.locator(".toast-v2 [data-title]").filter({ hasText: "Thinking effort: Default" })).toBeVisible()
  await expect(modelButton).not.toHaveAttribute("data-prompt-variant")

  // The per-model default set in manage models applies without touching the
  // composer and survives a reload.
  await openManageModels(page)
  const select = manageModelsRow(page, "Thinking Model").locator('[data-action="manage-models-reasoning"]')
  await expect(select).toBeVisible()
  await expect(select).toContainText("Default")

  await select.click()
  // The dialog hides portaled content from the accessibility tree (Kobalte
  // hide-outside), so locate the option by text instead of role.
  const high = page.locator('[role="option"]').filter({ hasText: "High" })
  await expect(high).toBeVisible()
  await high.click()

  await expect(select).toContainText("High")

  await page.reload()
  await expectAppVisible(composer)

  await idleComposer(page)
  await expect(modelButton).toHaveAttribute("data-prompt-variant", "high")

  await openManageModels(page)
  await expect(select).toContainText("High")
})

function manageModelsRow(page: Page, model: string) {
  return page.locator('[data-component="settings-v2-row"]').filter({ hasText: model })
}

async function idleComposer(page: Page) {
  await page.mouse.move(0, 0)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
}

async function openManageModels(page: Page) {
  await page.locator('[data-action="prompt-model"]').click()
  const manage = page.getByRole("menuitem", { name: "Manage models" })
  await expectAppVisible(manage)
  await manage.click()
  await expectAppVisible(page.getByPlaceholder("Search models"))
  await idleComposer(page)
}
