import { describe, expect, test } from "bun:test"
import { applyThemeFavicon, drawFavicon } from "@opencode-ai/ui/theme/favicon"

const HEAD = `<link rel="icon" type="image/png" href="/favicon-96x96-v3.png" sizes="96x96" />
<link rel="icon" type="image/svg+xml" href="/favicon-v3.svg" />
<link rel="shortcut icon" href="/favicon-v3.ico" />`

function fakeCanvas(href: string) {
  const calls: string[] = []
  const ctx = {
    fillRect: (x: number, y: number, w: number, h: number) => calls.push(`rect:${x},${y},${w},${h}`),
    beginPath: () => calls.push("begin"),
    rect: (x: number, y: number, w: number, h: number) => calls.push(`rect:${x},${y},${w},${h}`),
    fill: (rule?: string) => calls.push(`fill-rule:${rule}`),
  } as unknown as CanvasRenderingContext2D
  return { ctx, toDataURL: () => href, calls }
}

describe("theme favicon", () => {
  test("draws a full-bleed colored square with a white evenodd frame", () => {
    const canvas = fakeCanvas("")
    drawFavicon(canvas.ctx, "#808080")
    expect(canvas.calls).toEqual([
      "rect:0,0,64,64",
      "begin",
      "rect:16,12,32,40",
      "rect:24,20,16,24",
      "fill-rule:evenodd",
    ])
  })

  test("rewrites every icon link to the same png data uri", () => {
    document.head.innerHTML = HEAD
    document.documentElement.style.setProperty("--v2-grey-600", "#808080")
    const canvas = fakeCanvas("data:image/png,COLORED")

    applyThemeFavicon(document, () => canvas)

    const links = [...document.head.querySelectorAll("link[rel='icon'], link[rel='shortcut icon']")]
    expect(links).toHaveLength(3)
    for (const link of links) {
      expect(link.getAttribute("href")).toBe("data:image/png,COLORED")
      expect(link.getAttribute("type")).toBe("image/png")
    }
    expect(canvas.calls).toContain("rect:0,0,64,64")
  })

  test("leaves the static favicons in place when no main color is defined", () => {
    document.head.innerHTML = HEAD
    document.documentElement.style.removeProperty("--v2-grey-600")

    applyThemeFavicon()

    for (const link of document.head.querySelectorAll("link[rel='icon'], link[rel='shortcut icon']")) {
      expect(link.getAttribute("href")).not.toContain("data:")
    }
  })

  test("skips rewriting when no 2d context is available", () => {
    document.head.innerHTML = HEAD
    document.documentElement.style.setProperty("--v2-grey-600", "#808080")

    applyThemeFavicon(document, () => ({ ctx: null, toDataURL: () => "data:image/png,NEVER" }))

    for (const link of document.head.querySelectorAll("link[rel='icon'], link[rel='shortcut icon']")) {
      expect(link.getAttribute("href")).not.toBe("data:image/png,NEVER")
    }
  })
})
