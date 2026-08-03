import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Guards on the stylesheet's theming, written after the light theme shipped with a black canvas
 * and a dark sessions sidebar.
 *
 * The bug was not any one rule — it was the AUDIT. The literals were found by listing the most
 * frequent colours, which silently skips the ones used once: `.react-flow { background: #000000 }`
 * is the entire canvas and appeared exactly once. A test doesn't get bored at entry 26.
 */

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')

/** Everything before the end of the `:root[data-theme='light']` block — where literals belong. */
const TOKEN_BLOCK_END = CSS.indexOf('\n}\n', CSS.indexOf(":root[data-theme='light']")) + 3
const RULES = CSS.slice(TOKEN_BLOCK_END)

function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
}

function parseColor(lit: string): { lum: number; alpha: number } | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(lit.trim())
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return {
      lum: luminance(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)),
      alpha: 1
    }
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(lit.trim())
  if (rgb) {
    return {
      lum: luminance(+rgb[1], +rgb[2], +rgb[3]),
      alpha: rgb[4] === undefined ? 1 : +rgb[4]
    }
  }
  return null
}

/**
 * Scrims: a translucent wash whose JOB is to darken whatever is under it. Black is correct in
 * both themes, so these are the one legitimate place for a literal dark background. Listed
 * explicitly, so adding one is a decision rather than an oversight.
 */
const SCRIM_ALPHA_MAX = 0.8

describe('every opaque surface is themed', () => {
  // `background: <literal>` outside the token block. An opaque near-black or near-white here is a
  // surface that will not follow the theme — exactly the canvas/dock/sidebar failure.
  const offenders: string[] = []
  let selector = ''
  const lines = RULES.split('\n')
  lines.forEach((line, i) => {
    if (line.includes('{')) selector = line.split('{')[0].trim() || selector
    const decl = /^\s*background(?:-color)?:\s*([^;]+);/.exec(line)
    if (!decl) return
    // Drop `var(--x, <fallback>)` wholesale before looking for literals: a fallback is only
    // reached when the variable is undefined, and the previous test already proves none are.
    // An explicit `theme-exempt:` comment on the line above opts a rule out — the QR quiet zone
    // is content, not chrome, and has to stay light in both themes. A marker makes that a stated
    // decision instead of an oversight, which is the whole point of this test.
    if (lines[i - 1]?.includes('theme-exempt:') || lines[i - 2]?.includes('theme-exempt:')) return
    const value = decl[1].replace(/var\([^)]*\)/g, '')
    for (const lit of value.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)/g) ?? []) {
      const c = parseColor(lit)
      if (!c) continue
      const extreme = c.lum < 0.25 || c.lum > 0.85
      if (extreme && c.alpha > SCRIM_ALPHA_MAX) {
        offenders.push(`${selector || '?'} (line ~${i + 1}): ${lit}`)
      }
    }
  })

  it('has no un-themed near-black or near-white background', () => {
    expect(offenders).toEqual([])
  })
})

describe('every CSS variable resolves', () => {
  // `var(--label, #fff)` looked themed and was not: `--label` never existed, so every one of those
  // sites was a hardcoded white. A referenced-but-undefined variable is either that trap or a
  // typo — unless the renderer sets it at runtime.
  const SET_FROM_JS = new Set([
    '--term-bg', // App.tsx, from the terminal theme
    '--peer-color', // presence chips, per peer
    '--group-label-boost', // GroupNode, zoom-compensated label size
    '--mascot-w',
    '--mascot-h',
    '--cmascot-w',
    '--cmascot-h',
    '--cmascot-sheet-w',
    '--cmascot-sheet-h' // notch HUD sprite sheets
  ])

  it('references no variable that is never defined', () => {
    const defined = new Set(Array.from(CSS.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), (x) => x[1]))
    const used = new Set(Array.from(CSS.matchAll(/var\(\s*(--[a-z0-9-]+)/g), (x) => x[1]))
    const dangling = [...used].filter((v) => !defined.has(v) && !SET_FROM_JS.has(v)).sort()
    expect(dangling).toEqual([])
  })
})

describe('the light theme overrides every themeable token', () => {
  // A token defined in `:root` but absent from the light block keeps its DARK value on a light
  // page. Colour-valued tokens must appear in both; geometry (radii, fonts) is theme-independent.
  it('covers every colour token', () => {
    const dark = CSS.slice(CSS.indexOf(':root {'), CSS.indexOf(":root[data-theme='light']"))
    const light = CSS.slice(CSS.indexOf(":root[data-theme='light']"), TOKEN_BLOCK_END)
    const colourish = (decl: string): boolean =>
      /#[0-9a-f]{3,8}|rgba?\(|^\s*\d+,\s*\d+,\s*\d+\s*$/i.test(decl)

    const darkTokens = Array.from(dark.matchAll(/^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm))
      .filter(([, , v]) => colourish(v))
      .map(([, k]) => k)
    const lightTokens = new Set(
      Array.from(light.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm), (x) => x[1])
    )

    // The git-graph lane hues are branch IDENTITY, not chrome: they must stay the same colour in
    // both themes or a graph would change meaning when the theme flips.
    const themeIndependent = (k: string): boolean => k.startsWith('--git-graph-')
    const missing = darkTokens.filter((k) => !lightTokens.has(k) && !themeIndependent(k))
    expect(missing).toEqual([])
  })
})
