import { describe, expect, test } from "bun:test"
import { applyThemeFavicon, faviconSvg } from "@opencode-ai/ui/theme/favicon"

const ICON_LINK = '<link rel="icon" type="image/svg+xml" href="/favicon-v3.svg" />'

describe("theme favicon", () => {
  test("encodes the accent color into a data-uri svg", () => {
    const href = faviconSvg("#ff8800")
    expect(href.startsWith("data:image/svg+xml,")).toBe(true)
    expect(decodeURIComponent(href)).toContain('fill="#ff8800"')
  })

  test("rewrites the svg icon link from the theme accent", () => {
    document.head.innerHTML = ICON_LINK
    document.documentElement.style.setProperty("--v2-icon-icon-accent", "#ff8800")

    applyThemeFavicon()

    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]')
    expect(link?.getAttribute("href")).toBe(faviconSvg("#ff8800"))
  })

  test("leaves the static favicon in place when no accent is defined", () => {
    document.head.innerHTML = ICON_LINK
    document.documentElement.style.removeProperty("--v2-icon-icon-accent")

    applyThemeFavicon()

    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]')
    expect(link?.getAttribute("href")).toBe("/favicon-v3.svg")
  })
})
