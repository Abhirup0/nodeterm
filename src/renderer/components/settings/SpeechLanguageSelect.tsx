import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { speechLanguage, speechLanguageLabel } from '@shared/speech'
import { useMenuFlip } from '@renderer/ui/useMenuFlip'
import { moveRow, speechLanguageRows } from '@renderer/lib/speechLanguageRows'

/**
 * Speech-language picker: the app's own dropdown idiom (`.bind-select` trigger + a portaled
 * `.tab-menu` with a pinned filter over a scrolling list — the same shape as the Source Control
 * branch quick-pick), NOT a native `<select>`.
 *
 * A `<select>` was the whole reason issue #586 existed. With whisper's real language set it would
 * be a 101-row scroll with no search, unreachable by typing an endonym; and a stored code it does
 * not carry renders as an EMPTY row, which the next click in the field then overwrites — so the
 * control that cannot display a value also destroys it. Here the current value always has a row.
 */
export function SpeechLanguageSelect({
  value,
  onChange
}: {
  value: string
  onChange: (code: string) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<{
    top: number
    left: number
    width: number
    base: number
  } | null>(null)
  const known = speechLanguage(value)

  const open = (e: MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    // `base` is the trigger's TOP edge, so a list that would overflow the viewport flips to open
    // ABOVE the trigger rather than above the 4px gap (see useMenuFlip).
    setMenu({ top: r.bottom + 4, left: r.left, width: r.width, base: r.top })
  }

  return (
    <>
      <button
        type="button"
        className="bind-select speech-lang__trigger"
        aria-label="Speech language"
        onClick={open}
      >
        <span className="bind-select__val">{speechLanguageLabel(value)}</span>
        {known && known.endonym.toLowerCase() !== known.label.toLowerCase() ? (
          <span className="speech-lang__endonym">{known.endonym}</span>
        ) : null}
        <span className="bind-select__chev">⌄</span>
      </button>
      {menu && (
        <LanguageMenu
          anchor={menu}
          value={value}
          onPick={(code) => {
            onChange(code)
            setMenu(null)
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  )
}

function LanguageMenu({
  anchor,
  value,
  onPick,
  onClose
}: {
  anchor: { top: number; left: number; width: number; base: number }
  value: string
  onPick: (code: string) => void
  onClose: () => void
}): React.ReactPortal {
  // Hook lives in its own component so it isn't called conditionally in the trigger above.
  const flip = useMenuFlip(anchor.top, anchor.left, anchor.base)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const rows = speechLanguageRows(query, value)
  const listRef = useRef<HTMLDivElement>(null)

  // A new query renumbers the rows, so the cursor goes back to the best match.
  useEffect(() => setActive(0), [query])

  // Keep the keyboard cursor in view — with 101 rows the highlight is otherwise off-screen the
  // moment you arrow past the visible few.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active])

  return createPortal(
    <>
      <div className="tab-backdrop" style={{ zIndex: 78 }} onClick={onClose} />
      <div
        ref={flip.ref}
        className="tab-menu speech-lang__menu"
        style={{ top: flip.top, left: flip.left, minWidth: anchor.width, zIndex: 80 }}
      >
        <input
          className="tab__edit tab-menu__filter"
          placeholder="Search languages — name, code or “polski”"
          value={query}
          autoFocus
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              // The Settings dialog closes on Escape too; the picker gets this one.
              e.stopPropagation()
              onClose()
              return
            }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((a) => moveRow(a, e.key === 'ArrowDown' ? 1 : -1, rows.length))
              return
            }
            if (e.key === 'Enter' && rows[active]) onPick(rows[active].code)
          }}
        />
        {/* --scroll on the LIST only, so the filter input never scrolls away. */}
        <div ref={listRef} className="tab-menu__list tab-menu--scroll" role="listbox">
          {rows.length === 0 ? (
            <div className="speech-lang__empty">No language matches “{query.trim()}”.</div>
          ) : (
            rows.map((r, i) => (
              <button
                type="button"
                key={r.code}
                role="option"
                aria-selected={r.code === value}
                className={i === active ? 'speech-lang__row is-active' : 'speech-lang__row'}
                onMouseEnter={() => setActive(i)}
                onClick={() => onPick(r.code)}
              >
                <span className="tab-menu__check">{r.code === value ? '✓' : ''}</span>
                <span className="speech-lang__name">{r.label}</span>
                {r.hint ? <span className="speech-lang__hint">{r.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </>,
    document.body
  )
}
