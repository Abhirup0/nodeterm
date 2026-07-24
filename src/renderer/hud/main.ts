// Notch HUD renderer (docs/notch-hud.md). Plain TS/DOM — no React. Draws the collapsed indicator
// (walking mascots beside the notch) and the expanded mini session panel, reusing lib/mascot.ts art
// + the walk-cycle CSS. Reports pointer enter/leave of the hotspot to main to toggle click-through,
// and row clicks to focus the node in nodeterm.

import './hud.css'
import { CLAUDE_MASCOT, CODEX_MASCOT } from '../lib/mascot'
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

// The single interactive hotspot (indicator + panel).
const hotspot = document.createElement('div')
hotspot.className = 'hud-hotspot'
const indicator = document.createElement('div')
indicator.className = 'hud-indicator'
const panel = document.createElement('div')
panel.className = 'hud-panel'
hotspot.append(indicator, panel)
root.append(hotspot)

let expanded = false
let latestRows: HudRow[] = []
// Which subagent disclosures the user has opened (by nodeId), preserved across re-renders.
const openSubs = new Set<string>()

// ---- Interaction: click-through hotspot + expand/collapse ----------------------------------

// While the window is click-through (setIgnoreMouse(true,{forward:true})), the OS still forwards
// MOVE events, so pointerenter fires and we can flip click-through OFF to accept clicks. Leaving
// the hotspot re-enables click-through and collapses the panel (the click-away).
hotspot.addEventListener('pointerenter', () => {
  window.hud.setIgnoreMouse(false)
})
hotspot.addEventListener('pointerleave', () => {
  window.hud.setIgnoreMouse(true)
  if (expanded) setExpanded(false)
})
indicator.addEventListener('click', () => setExpanded(!expanded))

function setExpanded(next: boolean): void {
  if (expanded === next) return
  expanded = next
  hotspot.classList.toggle('expanded', expanded)
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

function claudeMascot(): HTMLElement {
  const el = document.createElement('span')
  el.className = 'mascot mascot--claude'
  el.style.setProperty('--mascot-w', `${CLAUDE_MASCOT.frameWidth}px`)
  el.style.setProperty('--mascot-h', `${CLAUDE_MASCOT.frameHeight}px`)
  el.style.backgroundImage = `url(${CLAUDE_MASCOT.src})`
  return el
}
function codexMascot(): HTMLElement {
  const el = document.createElement('span')
  el.className = 'mascot mascot--codex'
  el.style.setProperty('--cmascot-w', `${CODEX_MASCOT.frameWidth}px`)
  el.style.setProperty('--cmascot-h', `${CODEX_MASCOT.frameHeight}px`)
  el.style.setProperty('--cmascot-sheet-w', `${CODEX_MASCOT.frameWidth * CODEX_MASCOT.cols}px`)
  el.style.setProperty('--cmascot-sheet-h', `${CODEX_MASCOT.frameHeight * CODEX_MASCOT.rows}px`)
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
  for (const r of rows) {
    if (r.state === 'working') {
      const id = r.agentId || 'unknown'
      if (!workingAgents.includes(id)) workingAgents.push(id)
    } else if (r.state === 'done') {
      doneUnseen = true
    }
  }
  for (const agentId of workingAgents) indicator.append(workingMascot(agentId))
  if (doneUnseen) {
    const blob = document.createElement('span')
    blob.className = 'done-blob'
    indicator.append(blob)
  }
}

// ---- Expanded panel ------------------------------------------------------------------------

function renderPanel(rows: HudRow[]): void {
  panel.replaceChildren()
  const shown = rows.slice(0, 6)
  for (const row of shown) panel.append(buildRow(row))
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
  // Auto-collapse if there is nothing to show.
  if (rows.length === 0 && expanded) setExpanded(false)
}

function applyGeometry(push: HudPush): void {
  document.documentElement.style.setProperty('--bar', `${push.bar}px`)
}

window.hud.onRows((push: HudPush) => {
  applyGeometry(push)
  render(push.rows ?? [])
})

// Refresh reltimes every 20s even without a push.
setInterval(() => {
  if (latestRows.length > 0) renderPanel(latestRows)
}, 20_000)
