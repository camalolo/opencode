// Tints the tab favicon with the theme accent so multiple opencode servers
// (one per origin) are distinguishable in a browser's tab bar.

const ACCENT_VAR = "--v2-icon-icon-accent"

export function faviconSvg(accent: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="#131010"/><path d="M320 224V352H192V224H320Z" fill="${accent}"/><path fill-rule="evenodd" clip-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="white"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function applyThemeFavicon(doc: Document = document) {
  const accent = doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue(ACCENT_VAR).trim()
  if (!accent) return
  const link = doc.head.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
  if (!link) return
  const href = faviconSvg(accent)
  if (link.getAttribute("href") !== href) link.setAttribute("href", href)
}
