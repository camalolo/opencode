// Colors the tab favicon with the theme's main color (mid step of the
// theme-derived grey ramp) so multiple opencode servers (one per origin)
// are distinguishable in a browser's tab bar.

const MAIN_COLOR_VAR = "--v2-grey-600"

export function faviconSvg(color: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" fill="${color}"/><path fill-rule="evenodd" clip-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z" fill="white"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

export function applyThemeFavicon(doc: Document = document) {
  const color = doc.defaultView?.getComputedStyle(doc.documentElement).getPropertyValue(MAIN_COLOR_VAR).trim()
  if (!color) return
  const link = doc.head.querySelector<HTMLLinkElement>('link[rel="icon"][type="image/svg+xml"]')
  if (!link) return
  const href = faviconSvg(color)
  if (link.getAttribute("href") !== href) link.setAttribute("href", href)
}
