// The official Grok mark (xAI), as raw geometry so BOTH renderers can draw it: the React
// `AgentIcon` / `AgentMascot` in the canvas, and the plain-DOM notch HUD, which builds its nodes
// imperatively and cannot use JSX.
//
// A single monochrome path is the whole reason grok is drawn rather than shipped as an asset: with
// `fill="currentColor"` the mark takes the surrounding label colour, black-on-light and
// white-on-dark, which is the vendor's own usage — and an SVG loaded through `<img src>` is an
// isolated document where `currentColor` resolves against nothing and paints black, invisible on the
// default dark theme.

/** The mark's own aspect box. NOT square — squaring it would stretch the glyph. */
export const GROK_MARK_VIEWBOX = '0 0 512 492'

export const GROK_MARK_PATH =
  'M197.76 315.52l170.197-125.803c8.342-6.186 20.267-3.776 24.256 5.803 20.907 50.539 11.563 111.253-30.08 152.939-41.621 41.685-99.562 50.816-152.512 29.994l-57.834 26.816c82.965 56.768 183.701 42.731 246.656-20.33 49.941-50.006 65.408-118.166 50.944-179.627l.128.149c-20.971-90.282 5.162-126.378 58.666-200.17 1.28-1.75 2.56-3.499 3.819-5.291l-70.421 70.507v-.214l-243.883 245.27m-35.072 30.528c-59.563-56.96-49.28-145.088 1.515-195.926 37.568-37.61 99.136-52.97 152.874-30.4l57.707-26.666a166.554 166.554 0 00-39.019-21.334 191.467 191.467 0 00-208.042 41.942c-54.038 54.101-71.04 137.301-41.856 208.298 21.802 53.056-13.931 90.582-49.92 128.47C23.104 463.915 10.304 477.333 0 491.541l162.56-145.386'

/**
 * Build the mark as a real SVG element, for the imperative renderer (the notch HUD).
 *
 * `createElementNS` rather than `innerHTML`: the path is a static constant so there is nothing to
 * inject, but building nodes is the same cost and keeps the HUD free of any HTML-string parsing
 * habit that a later, less-static caller could inherit.
 */
export function createGrokMarkSvg(size: number, className: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', GROK_MARK_VIEWBOX)
  // No explicit fill: `fill="currentColor"` is the point, and it is the SVG default for a path
  // whose ancestors set `color`. Set it anyway so the element is self-describing out of context.
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', className)
  const path = document.createElementNS(NS, 'path')
  path.setAttribute('fill-rule', 'evenodd')
  path.setAttribute('clip-rule', 'evenodd')
  path.setAttribute('d', GROK_MARK_PATH)
  svg.appendChild(path)
  return svg
}
