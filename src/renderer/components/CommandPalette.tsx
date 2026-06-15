import { useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface Command {
  id: string
  label: string
  hint?: string
  section?: string
  icon?: ReactNode
  run: () => void
}

interface CommandPaletteProps {
  commands: Command[]
  onClose: () => void
}

/** Case-insensitive subsequence match — "ntr" matches "New TeRminal". */
function matches(label: string, q: string): boolean {
  if (!q) return true
  const s = label.toLowerCase()
  let i = 0
  for (const ch of q.toLowerCase()) {
    i = s.indexOf(ch, i)
    if (i === -1) return false
    i++
  }
  return true
}

/** Cmd/Ctrl+K command palette: fuzzy-filter actions and jump targets, Enter to run. */
export function CommandPalette({ commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const filtered = useMemo(
    () => commands.filter((c) => matches(`${c.label} ${c.hint ?? ''}`, query)).slice(0, 50),
    [commands, query]
  )

  const run = (cmd?: Command) => {
    if (!cmd) return
    cmd.run()
    onClose()
  }

  return createPortal(
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          className="palette__input"
          autoFocus
          spellCheck={false}
          placeholder="Type a command or name…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setActive(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((a) => Math.min(a + 1, filtered.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => Math.max(a - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              run(filtered[active])
            } else if (e.key === 'Escape') {
              onClose()
            }
          }}
        />
        <div className="palette__list">
          {filtered.length === 0 && <div className="palette__empty">No matches</div>}
          {filtered.map((c, i) => (
            <button
              key={c.id}
              className={`palette__item${i === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => run(c)}
            >
              <span className="palette__icon">{c.icon}</span>
              <span className="palette__label">{c.label}</span>
              {c.hint && <span className="palette__hint">{c.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}
