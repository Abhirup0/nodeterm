// Notch HUD renderer (docs/notch-hud.md). Plain TS/DOM — no React. Draws the collapsed indicator
// (walking mascots beside the notch) and the expanded mini session panel, reusing lib/mascot.ts art
// + the walk-cycle CSS. Reports pointer enter/leave of the hotspot to main to toggle click-through,
// and row clicks to focus the node in nodeterm.

import './hud.css'
import { CLAUDE_MASCOT, CODEX_MASCOT, DONE_BLOB } from '../lib/mascot'
import { orderIndicatorAgents } from './indicator'
import codexPet from '../assets/pet-codex.webp'

// Local mirror of the preload's HUD contract (src/preload/hud.ts) — kept self-contained so this
// renderer entry has no cross-project (main/preload) type dependency.
interface HudSubagentRow {
  id: string
  label?: string
  state: 'working' | 'done'
}
interface HudRow {
  nodeId: string
  agentId?: string
  title: string
  model?: string
  state: 'working' | 'needsYou' | 'done' | 'idle'
  prompt?: string
  activity?: string
  contextPercent?: number
  subagents: HudSubagentRow[]
  updatedAt: number
}
interface HudPush {
  rows: HudRow[]
  bar: number
  width: number
  notchWidth: number
  notchCenterX: number
  hasNotch: boolean
}
interface HudApi {
  onRows(cb: (push: HudPush) => void): () => void
  setIgnoreMouse(ignore: boolean): void
  focusNode(nodeId: string): void
  setExpanded(expanded: boolean): void
}

declare global {
  interface Window {
    hud: HudApi
  }
}

const root = document.getElementById('hud') as HTMLDivElement

// One black rounded-bottom surface — the DynamicNotch capsule — fused to the physical notch. It IS
// the interactive hotspot: the walking mascots live INSIDE it (collapsed), and clicking it grows
// the SAME surface downward into the session panel (expanded).
const capsule = document.createElement('div')
// Start hidden so there is no flash of an empty black pill before the first rows push.
capsule.className = 'hud-capsule hud-capsule--hidden'
const indicator = document.createElement('div')
indicator.className = 'hud-indicator'
const panel = document.createElement('div')
panel.className = 'hud-panel'
capsule.append(indicator, panel)
root.append(capsule)

let expanded = false
let latestRows: HudRow[] = []
// Which subagent disclosures the user has opened (by nodeId), preserved across re-renders.
const openSubs = new Set<string>()

// ---- Interaction: click-through hotspot + expand/collapse ----------------------------------

// The capsule IS the hotspot. While the window is click-through (setIgnoreMouse(true,{forward:true})),
// the OS still forwards MOVE events, so pointerenter fires and we flip click-through OFF to accept
// clicks. Leaving the capsule re-enables click-through and collapses the panel (the click-away). The
// transparent rest of the window stays click-through throughout.
// HOVER OPENS IT (owner: "üzerine gelince genişleme yok"). A short dwell keeps a pointer merely
// crossing the top edge from popping the panel; leaving collapses immediately. Clicking still
// toggles, so the panel can also be dismissed without moving away.
const HOVER_OPEN_MS = 180
let hoverTimer: number | undefined

capsule.addEventListener('pointerenter', () => {
  window.hud.setIgnoreMouse(false)
  window.clearTimeout(hoverTimer)
  hoverTimer = window.setTimeout(() => setExpanded(true), HOVER_OPEN_MS)
})
capsule.addEventListener('pointerleave', () => {
  window.clearTimeout(hoverTimer)
  window.hud.setIgnoreMouse(true)
  if (expanded) setExpanded(false)
})
indicator.addEventListener('click', () => {
  window.clearTimeout(hoverTimer)
  setExpanded(!expanded)
})

function setExpanded(next: boolean): void {
  if (expanded === next) return
  expanded = next
  capsule.classList.toggle('expanded', expanded)
  window.hud.setExpanded(expanded)
}

// ---- Relative time -------------------------------------------------------------------------

function reltime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return `${h}h`
}

// ---- Mascot / icon builders ----------------------------------------------------------------

// Indicator mascot heights in the menu-bar strip (px). agent-notch draws Claude ~ the bar height
// and the Codex pet at 26px; these are the sensible defaults — NAIL EXACTLY ON A MAC (the notch
// bar height varies by model, and 26px overflows a short bar). Aspect ratios are preserved from
// the sprite geometry, so only the height matters.
const HUD_CLAUDE_H = 13
const HUD_CODEX_H = 17

function claudeMascot(): HTMLElement {
  const el = document.createElement('span')
  el.className = 'mascot mascot--claude'
  const h = HUD_CLAUDE_H
  const w = Math.round((h * CLAUDE_MASCOT.frameWidth) / CLAUDE_MASCOT.frameHeight)
  el.style.setProperty('--mascot-w', `${w}px`)
  el.style.setProperty('--mascot-h', `${h}px`)
  el.style.backgroundImage = `url(${CLAUDE_MASCOT.src})`
  return el
}
function codexMascot(): HTMLElement {
  const el = document.createElement('span')
  el.className = 'mascot mascot--codex'
  const h = HUD_CODEX_H
  const w = Math.round((h * CODEX_MASCOT.frameWidth) / CODEX_MASCOT.frameHeight)
  el.style.setProperty('--cmascot-w', `${w}px`)
  el.style.setProperty('--cmascot-h', `${h}px`)
  el.style.setProperty('--cmascot-sheet-w', `${w * CODEX_MASCOT.cols}px`)
  el.style.setProperty('--cmascot-sheet-h', `${h * CODEX_MASCOT.rows}px`)
  el.style.backgroundImage = `url(${codexPet})`
  return el
}
function workingMascot(agentId?: string): HTMLElement {
  if (agentId === 'claude' && CLAUDE_MASCOT.src) return claudeMascot()
  if (agentId === 'codex') return codexMascot()
  const dot = document.createElement('span')
  dot.className = 'mascot mascot--dot'
  return dot
}
function doneBlob(): HTMLElement {
  const blob = document.createElement('span')
  blob.className = 'done-blob'
  // 7×7 crisp green pixel circle (agent-notch look); CSS drives the shimmer. Falls back to the
  // CSS-only round blob when the sprite couldn't be built (no DOM canvas).
  if (DONE_BLOB.src) blob.style.backgroundImage = `url(${DONE_BLOB.src})`
  else blob.classList.add('done-blob--fallback')
  return blob
}
function rowIcon(row: HudRow): HTMLElement {
  if (row.state === 'working') return workingMascot(row.agentId)
  if (row.state === 'done') {
    const c = document.createElement('span')
    c.className = 'check'
    c.textContent = '✓'
    return c
  }
  // needsYou / idle
  const d = document.createElement('span')
  d.className = 'needs-dot'
  return d
}

// ---- Collapsed indicator -------------------------------------------------------------------

function renderIndicator(rows: HudRow[]): void {
  indicator.replaceChildren()
  const workingAgents: string[] = []
  let doneUnseen = false
  let needsYou = false
  for (const r of rows) {
    if (r.state === 'working') {
      const id = r.agentId || 'unknown'
      if (!workingAgents.includes(id)) workingAgents.push(id)
    } else if (r.state === 'done') {
      doneUnseen = true
    } else if (r.state === 'needsYou') {
      needsYou = true
    }
  }
  // Left→right paint order, centered inside the capsule's drop zone: a red "needs you" dot and the
  // green "done" blob sit furthest left, then the working mascots with Claude last (notch-side).
  // Surfacing needsYou here keeps the collapsed capsule meaningful (never an empty black pill) for a
  // session that is waiting on the user even when nothing is actively working.
  if (needsYou) {
    const d = document.createElement('span')
    d.className = 'needs-dot'
    indicator.append(d)
  }
  if (doneUnseen) indicator.append(doneBlob())
  for (const agentId of orderIndicatorAgents(workingAgents)) indicator.append(workingMascot(agentId))
}

// ---- Expanded panel ------------------------------------------------------------------------

function renderPanel(rows: HudRow[]): void {
  panel.replaceChildren()
  const shown = rows.slice(0, 6)
  shown.forEach((row, i) => {
    // Dithered pixel separator between rows (agent-notch's DitherSeparator).
    if (i > 0) {
      const sep = document.createElement('div')
      sep.className = 'hud-sep'
      panel.append(sep)
    }
    panel.append(buildRow(row))
  })
}

function buildRow(row: HudRow): HTMLElement {
  const el = document.createElement('div')
  el.className = 'hud-row'
  el.addEventListener('click', (e) => {
    // Don't hijack the disclosure toggle click.
    if ((e.target as HTMLElement).closest('.hud-subs__toggle')) return
    window.hud.focusNode(row.nodeId)
    setExpanded(false)
  })

  const icon = document.createElement('div')
  icon.className = 'hud-row__icon'
  icon.append(rowIcon(row))

  const title = document.createElement('div')
  title.className = 'hud-row__title'
  title.textContent = row.title

  const tag = document.createElement('div')
  tag.className = `hud-row__tag hud-row__tag--${row.state}`
  const parts: string[] = []
  if (row.model) parts.push(row.model)
  parts.push(reltime(row.updatedAt))
  if (typeof row.contextPercent === 'number') parts.push(`${Math.round(row.contextPercent)}%`)
  tag.textContent = parts.join(' · ')

  const sub = document.createElement('div')
  sub.className = 'hud-row__sub'
  if (row.prompt) {
    const b = document.createElement('b')
    b.textContent = 'You: '
    sub.append(b, document.createTextNode(row.prompt))
  } else if (row.activity) {
    sub.textContent = row.activity
  } else {
    sub.textContent = stateLabel(row.state)
  }

  el.append(icon, title, tag, sub)

  if (row.subagents.length > 0) el.append(buildSubs(row))

  const go = document.createElement('button')
  go.className = 'hud-row__go'
  go.textContent = 'Go'
  go.addEventListener('click', (e) => {
    e.stopPropagation()
    window.hud.focusNode(row.nodeId)
    setExpanded(false)
  })
  el.append(go)

  return el
}

function stateLabel(state: HudRow['state']): string {
  if (state === 'working') return 'Working…'
  if (state === 'needsYou') return 'Needs you'
  if (state === 'done') return 'Finished'
  return 'Idle'
}

function buildSubs(row: HudRow): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'hud-subs'
  const isOpen = openSubs.has(row.nodeId)
  const toggle = document.createElement('div')
  toggle.className = 'hud-subs__toggle'
  toggle.textContent = `${isOpen ? '▾' : '▸'} ${row.subagents.length} subagent${row.subagents.length === 1 ? '' : 's'}`
  toggle.addEventListener('click', (e) => {
    e.stopPropagation()
    if (openSubs.has(row.nodeId)) openSubs.delete(row.nodeId)
    else openSubs.add(row.nodeId)
    render(latestRows)
  })
  wrap.append(toggle)
  if (isOpen) {
    const list = document.createElement('ul')
    list.className = 'hud-subs__list'
    for (const s of row.subagents) list.append(buildSubItem(s))
    wrap.append(list)
  }
  return wrap
}

function buildSubItem(s: HudSubagentRow): HTMLElement {
  const li = document.createElement('li')
  const dot = document.createElement('span')
  dot.className = `hud-subs__dot hud-subs__dot--${s.state}`
  li.append(dot, document.createTextNode(s.label || s.state))
  return li
}

// ---- Render + geometry ---------------------------------------------------------------------

function render(rows: HudRow[]): void {
  latestRows = rows
  renderIndicator(rows)
  renderPanel(rows)
  // Idle → hide the whole capsule (no empty black pill); active → the fused capsule shows.
  capsule.classList.toggle('hud-capsule--hidden', rows.length === 0)
  // Auto-collapse if there is nothing to show.
  if (rows.length === 0 && expanded) setExpanded(false)
}

function applyGeometry(push: HudPush): void {
  const rs = document.documentElement.style
  rs.setProperty('--bar', `${push.bar}px`)
  if (typeof push.notchWidth === 'number') rs.setProperty('--notch-width', `${push.notchWidth}px`)
  if (typeof push.notchCenterX === 'number') rs.setProperty('--notch-center-x', `${push.notchCenterX}px`)
  // No physical notch → draw a standalone floating pill instead of fusing to y=0.
  document.documentElement.classList.toggle('notchless', push.hasNotch === false)
}

window.hud.onRows((push: HudPush) => {
  applyGeometry(push)
  render(push.rows ?? [])
})

// Refresh reltimes every 20s even without a push.
setInterval(() => {
  if (latestRows.length > 0) renderPanel(latestRows)
}, 20_000)
