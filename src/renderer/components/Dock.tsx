import { useState } from 'react'

interface DockProps {
  dirty: boolean
  zoomPct: number
  onAddTerminal: () => void
  onAddSticky: () => void
  onSave: () => void
  onFitView: () => void
  onZoomIn: () => void
  onZoomOut: () => void
}

/**
 * Bottom-center floating dock. The "+" opens a node-type menu above it.
 * All canvas actions live here so the canvas itself stays clean.
 */
export function Dock({
  dirty,
  zoomPct,
  onAddTerminal,
  onAddSticky,
  onSave,
  onFitView,
  onZoomIn,
  onZoomOut
}: DockProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  const pick = (fn: () => void) => () => {
    fn()
    setMenuOpen(false)
  }

  return (
    <>
      {menuOpen && <div className="dock-backdrop" onClick={() => setMenuOpen(false)} />}

      <div className="dock">
        {menuOpen && (
          <div className="dock-menu">
            <button onClick={pick(onAddTerminal)}>
              <TerminalIcon />
              <span>Terminal</span>
            </button>
            <button onClick={pick(onAddSticky)}>
              <NoteIcon />
              <span>Sticky Note</span>
            </button>
          </div>
        )}

        <button
          className={`dock-btn dock-add${menuOpen ? ' active' : ''}`}
          title="Add node"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <PlusIcon />
        </button>

        <span className="dock-sep" />

        <button className="dock-btn" title="Save" onClick={onSave}>
          <SaveIcon />
          <span className={`dock-dirty${dirty ? ' dirty' : ''}`} />
        </button>
        <button className="dock-btn" title="Fit view" onClick={onFitView}>
          <FrameIcon />
        </button>

        <span className="dock-sep" />

        <button className="dock-btn dock-zoom-btn" title="Zoom out" onClick={onZoomOut}>
          <MinusIcon />
        </button>
        <span className="dock-zoom">{zoomPct}%</span>
        <button className="dock-btn dock-zoom-btn" title="Zoom in" onClick={onZoomIn}>
          <PlusSmallIcon />
        </button>
      </div>
    </>
  )
}

/* ---- inline icons (stroke = currentColor) ---- */
const S = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }

function PlusIcon() {
  return (
    <svg {...S} width={20} height={20}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function PlusSmallIcon() {
  return (
    <svg {...S} width={15} height={15}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}
function MinusIcon() {
  return (
    <svg {...S} width={15} height={15}>
      <path d="M5 12h14" />
    </svg>
  )
}
function SaveIcon() {
  return (
    <svg {...S}>
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <path d="M17 21v-8H7v8M7 3v5h8" />
    </svg>
  )
}
function FrameIcon() {
  return (
    <svg {...S}>
      <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
    </svg>
  )
}
function TerminalIcon() {
  return (
    <svg {...S}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  )
}
function NoteIcon() {
  return (
    <svg {...S}>
      <path d="M4 4h16v11l-5 5H4z" />
      <path d="M20 15h-5v5" />
    </svg>
  )
}
