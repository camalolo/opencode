// Colors the tab favicon with the theme's main color (mid step of the
// theme-derived grey ramp) so multiple opencode servers (one per origin)
// are distinguishable in a browser's tab bar. The icon is rasterized to a
// PNG data URI and every icon link is rewritten, so Chrome has no static
// fallback left to show.

const MAIN_COLOR_VAR = "--v2-grey-600"
const ICON_SIZE = 64

type FaviconCanvas = {
  ctx: CanvasRenderingContext2D | null
  toDataURL: () => string
}

function defaultCanvas(doc: Document): FaviconCanvas {
  const canvas = doc.createElement("canvas")
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  return { ctx: canvas.getContext("2d"), toDataURL: () => canvas.toDataURL("image/png") }
}

// opencode glyph: white frame with a hollow center, drawn at 64px scale
// from the 512px viewBox of the original favicon (all coordinates / 8).
export function drawFavicon(ctx: CanvasRenderingContext2D, color: string) {
  ctx.fillStyle = color
  ctx.fillRect(0, 0, ICON_SIZE, ICON_SIZE)
  ctx.fillStyle = "#ffffff"
  ctx.beginPath()
  ctx.rect(16, 12, 32, 40)
  ctx.rect(24, 20, 16, 24)
  ctx.fill("evenodd")
}

export function applyThemeFavicon(doc: Document = document, makeCanvas = defaultCanvas) {
  const color = doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue(MAIN_COLOR_VAR).trim()
  if (!color) return
  const { ctx, toDataURL } = makeCanvas(doc)
  if (!ctx) return
  drawFavicon(ctx, color)
  const href = toDataURL()
  for (const link of doc.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"], link[rel="shortcut icon"]')) {
    if (link.getAttribute("href") === href) continue
    link.setAttribute("type", "image/png")
    link.setAttribute("href", href)
  }
}
