import { useEffect, useRef, useState } from 'react'

/**
 * Animated scenes for the first-run setup tour (OnboardingFlow). All motion is CSS-only
 * (keyframes in styles.css, `.onb-*`) so there are no new dependencies; every scene loops
 * and respects `prefers-reduced-motion` (styles.css freezes them to their final frame).
 */

/** Inline check icon — a literal "✓" is tofu on Linux's default font stack. */
export function OnbCheck({ size = 13 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12.5l5.5 5.5L20 6.5" />
    </svg>
  )
}

/** The nodeterm mark (same path as WelcomeScreen's, sized for the tour). */
export function OnbBrandMark({ size = 56 }: { size?: number }) {
  return (
    <svg viewBox="0 0 48 48" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id="onbg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a38dff" />
          <stop offset="1" stopColor="#622994" />
        </linearGradient>
      </defs>
      <path
        d="M13 12 L31 24 L13 36"
        fill="none"
        stroke="url(#onbg)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="13" cy="12" r="3.6" fill="#a38dff" />
      <circle cx="13" cy="36" r="3.6" fill="#a38dff" />
      <circle cx="31" cy="24" r="3.6" fill="#fff" />
      <rect x="33.5" y="32.5" width="10.5" height="5" rx="2.5" fill="#a38dff" />
    </svg>
  )
}

/** Floating ghost nodes + edges behind the welcome step — the canvas metaphor, sensed
 *  before it's explained. Pure decoration (aria-hidden). */
export function OnbGhostCanvas() {
  return (
    <div className="onb-ghosts" aria-hidden="true">
      <div className="onb-ghost onb-ghost--a" />
      <div className="onb-ghost onb-ghost--b" />
      <div className="onb-ghost onb-ghost--c" />
      <div className="onb-ghost onb-ghost--d" />
      <svg className="onb-ghost-edges" viewBox="0 0 800 500" preserveAspectRatio="none">
        <path d="M180 140 C 300 120, 380 220, 520 200" />
        <path d="M540 230 C 480 320, 340 340, 240 380" />
      </svg>
    </div>
  )
}

/** Right-click → context menu → an agent node pops onto the canvas. The highlighted menu
 *  row and the spawned node follow the currently selected default agent. */
export function SceneAgents({ label, color }: { label: string; color: string }) {
  return (
    <div className="onb-scene-canvas" aria-hidden="true">
      {/* click ripple where the cursor right-clicks */}
      <div className="onb-ripple" />
      {/* mock context menu */}
      <div className="onb-menu">
        <div className="onb-menu__row">New terminal</div>
        <div className="onb-menu__row onb-menu__row--hl">
          <span className="onb-dot" style={{ background: color }} />
          New {label}
        </div>
        <div className="onb-menu__row">New sticky note</div>
        <div className="onb-menu__row">Open file…</div>
      </div>
      {/* the spawned agent node */}
      <div className="onb-node" style={{ borderColor: color }}>
        <div className="onb-node__head">
          <span className="onb-dot" style={{ background: color }} />
          <span className="onb-node__title">{label}</span>
          <span className="onb-badge">RUNNING</span>
        </div>
        <div className="onb-node__body">
          <div className="onb-line onb-line--w70" />
          <div className="onb-line onb-line--w50" />
          <div className="onb-line onb-line--w60" />
        </div>
      </div>
      {/* animated cursor */}
      <svg className="onb-cursor" viewBox="0 0 24 24" width="18" height="18">
        <path
          d="M5 3l14 8-6 1.5L16 19l-2.5 1-3-6.5L6 17z"
          fill="#fff"
          stroke="rgba(0,0,0,0.55)"
          strokeWidth="1.2"
        />
      </svg>
    </div>
  )
}

/** Dictation: the shortcut keys depress, the mic pulses with a live waveform, and the
 *  transcribed text types into a mini terminal line. */
export function SceneDictation({ keys, hold }: { keys: string[]; hold: boolean }) {
  return (
    <div className="onb-scene-canvas onb-scene--dictation" aria-hidden="true">
      <div className="onb-kbd-row">
        {keys.map((k, i) => (
          <kbd key={i} className={`onb-kbd ${hold ? 'onb-kbd--hold' : ''}`} style={{ animationDelay: `${i * 0.12}s` }}>
            {k}
          </kbd>
        ))}
        {hold && <span className="onb-kbd-hint">hold</span>}
      </div>
      <div className="onb-mic">
        <div className="onb-mic__ring" />
        <div className="onb-mic__ring onb-mic__ring--late" />
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
        </svg>
        <div className="onb-wave">
          {[0, 1, 2, 3, 4].map((i) => (
            <span key={i} style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
      </div>
      <div className="onb-term-line">
        <span className="onb-term-prompt">❯</span>
        <span className="onb-term-typed">run the tests and fix what breaks</span>
        <span className="onb-caret" />
      </div>
    </div>
  )
}

const KANBAN_CARDS = [
  // [canvas x, canvas y, rotate] → column index + row index on the board
  { id: 0, c: [12, 18, -3], col: 0, row: 0, w: 64 },
  { id: 1, c: [150, 8, 2], col: 0, row: 1, w: 52 },
  { id: 2, c: [236, 52, -2], col: 1, row: 0, w: 58 },
  { id: 3, c: [58, 108, 3], col: 1, row: 1, w: 66 },
  { id: 4, c: [188, 128, -1], col: 2, row: 0, w: 48 }
]
const COL_X = [10, 112, 214]
const COL_LABELS = ['To Do', 'In Progress', 'Done']

/** Canvas ↔ kanban morph: scattered session cards fly into three labelled columns and back,
 *  on a timer (transition-driven, so a JS toggle is enough — no per-card keyframes). */
export function SceneKanban({ pulseKey }: { pulseKey?: number }) {
  const [board, setBoard] = useState(false)
  const reduced = useRef(
    typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
  )
  useEffect(() => {
    if (reduced.current) {
      setBoard(true) // static: show the board form
      return
    }
    const t = setInterval(() => setBoard((b) => !b), 2600)
    return () => clearInterval(t)
  }, [])
  // an external pulse (the user pressing ⌘⇧B for real) flips the scene too — the animation
  // answers their keystroke, which is the whole point of the try-it interaction
  const lastPulse = useRef(pulseKey)
  useEffect(() => {
    if (pulseKey !== undefined && pulseKey !== lastPulse.current) {
      lastPulse.current = pulseKey
      setBoard((b) => !b)
    }
  }, [pulseKey])

  return (
    <div className={`onb-scene-canvas onb-scene--kanban ${board ? 'is-board' : ''}`} aria-hidden="true">
      {COL_LABELS.map((l, i) => (
        <div key={l} className="onb-col" style={{ left: COL_X[i] }}>
          {l}
        </div>
      ))}
      {KANBAN_CARDS.map((k) => (
        <div
          key={k.id}
          className="onb-mini"
          style={
            board
              ? { left: COL_X[k.col], top: 34 + k.row * 34, transform: 'rotate(0deg)', width: 88 }
              : { left: k.c[0], top: k.c[1], transform: `rotate(${k.c[2]}deg)`, width: k.w }
          }
        >
          <span className="onb-mini__dot" />
          <span className="onb-mini__bar" />
        </div>
      ))}
    </div>
  )
}

/** A mock OS notification sliding in — what enabling notifications buys you. */
export function SceneNotify() {
  return (
    <div className="onb-scene-canvas onb-scene--notify" aria-hidden="true">
      <svg className="onb-bell" viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      <div className="onb-notif">
        <div className="onb-notif__icon">
          <OnbBrandMark size={22} />
        </div>
        <div className="onb-notif__text">
          <div className="onb-notif__title">Claude Code finished</div>
          <div className="onb-notif__body">fix-auth · tests passing</div>
        </div>
        <div className="onb-notif__time">now</div>
      </div>
    </div>
  )
}
