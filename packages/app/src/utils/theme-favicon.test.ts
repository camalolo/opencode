import { describe, expect, test } from "bun:test"
import { applyThemeFavicon, faviconSvg } from "@opencode-ai/ui/theme/favicon"

const ICON_LINK = '<link rel="icon" type="image/svg+xml" href="/favicon-v3.svg" />'

describe("theme favicon", () => {
  test("colors the whole icon with the theme main color", () => {
    const href = faviconSvg("#808080")
    expect(href.startsWith("data:image/svg+xml,")).toBe(true)
    const svg = decodeURIComponent(href)
    expect(svg).toContain('rect width="512" height="512" fill="#808080"')
    expect(svg).toContain('fill="white"')
    expect(svg).not.toContain("#131010")
  })

  test("rewrites the svg icon link from the theme main color", () => {
    document.head.innerHTML = ICON_LINK
    document.documentElement.style.setProperty("--v2-grey-600", "#808080")

    applyThemeFavicon()

    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]')
    expect(link?.getAttribute("href")).toBe(faviconSvg("#808080"))
  })

  test("leaves the static favicon in place when no main color is defined", () => {
    document.head.innerHTML = ICON_LINK
    document.documentElement.style.removeProperty("--v2-grey-600")

    applyThemeFavicon()

    const link = document.querySelector('link[rel="icon"][type="image/svg+xml"]')
    expect(link?.getAttribute("href")).toBe("/favicon-v3.svg")
  })
})
