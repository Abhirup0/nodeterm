import { useEffect } from 'react'
import { createPortal } from 'react-dom'

interface ShortcutsPanelProps {
  onClose: () => void
}

interface Row {
  keys: string[]
  label: string
}

const SECTIONS: { title: string; rows: Row[] }[] = [
  {
    title: 'General',
    rows: [
      { keys: ['⌘', 'K'], label: 'Command palette' },
      { keys: ['⌘', ','], label: 'Settings' },
      { keys: ['⌘', '/'], label: 'This shortcuts panel' },
      { keys: ['⌘', 'Z'], label: 'Undo' },
      { keys: ['⌘', '⇧', 'Z'], label: 'Redo' }
    ]
  },
  {
    title: 'Canvas',
    rows: [
      { keys: ['⌘', 'T'], label: 'New terminal' },
      { keys: ['⌘', '⇧', 'C'], label: 'New Claude Code' },
      { keys: ['⌘', 'W'], label: 'Close selected node' },
      { keys: ['Right-click'], label: 'Actions menu (empty space or node)' },
      { keys: ['Left-drag'], label: 'Box-select (touch to select)' },
      { keys: ['Middle / Right-drag'], label: 'Pan the canvas' },
      { keys: ['Double-click'], label: 'Center & focus a node' },
      { keys: ['⌘', 'wheel'], label: 'Zoom in / out' }
    ]
  },
  {
    title: 'Terminal',
    rows: [
      { keys: ['Hover ~0.6s'], label: 'Enter the terminal (type/select)' },
      { keys: ['Quick drag'], label: 'Move the terminal (before it focuses)' },
      { keys: ['⌘', 'M'], label: 'Toggle markdown view' },
      { keys: ['⌘', 'C'], label: 'Copy selection (markdown view)' },
      { keys: ['✦'], label: 'Name the terminal with AI' }
    ]
  },
  {
    title: 'Source Control',
    rows: [{ keys: ['⌘', '↵'], label: 'Commit the staged changes' }]
  }
]

/** Keyboard shortcuts reference; shown on first launch and via ⌘/ or the ? button. */
export function ShortcutsPanel({ onClose }: ShortcutsPanelProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="sc-overlay" onClick={onClose}>
      <div className="shortcuts" onClick={(e) => e.stopPropagation()}>
        <div className="shortcuts__head">
          <h2>Keyboard shortcuts</h2>
          <button className="drawer__close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="shortcuts__body">
          {SECTIONS.map((s) => (
            <section key={s.title}>
              <h3>{s.title}</h3>
              {s.rows.map((r) => (
                <div key={r.label} className="shortcut-row">
                  <span className="shortcut-label">{r.label}</span>
                  <span className="shortcut-keys">
                    {r.keys.map((k, i) => (
                      <kbd key={i} className="kbd">
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
