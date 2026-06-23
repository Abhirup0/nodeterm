import { useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * VS Code-style "Publish to GitHub" picker: an editable repository name plus a
 * choice between a private and a public repository — all in-app, no terminal.
 * The chosen name + visibility are handed back to the caller, which performs
 * the actual `gh repo create` (in-process when gh is authed, otherwise via a
 * chained terminal login).
 */
export function PublishDialog({
  defaultName,
  owner,
  onCancel,
  onPublish
}: {
  defaultName: string
  owner?: string
  onCancel: () => void
  onPublish: (name: string, isPrivate: boolean) => void
}) {
  const [name, setName] = useState(defaultName)
  const trimmed = name.trim()
  const hint = (vis: string) => `${owner ? `${owner}/` : ''}${trimmed || 'repo'} · ${vis}`

  return createPortal(
    <div className="pubdlg-overlay" onClick={onCancel}>
      <div
        className="pubdlg"
        role="dialog"
        aria-label="Publish to GitHub"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          className="pubdlg__name"
          autoFocus
          spellCheck={false}
          value={name}
          placeholder="Repository name"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onCancel()
            if (e.key === 'Enter' && trimmed) onPublish(trimmed, true)
          }}
        />
        <button
          className="pubdlg__opt"
          disabled={!trimmed}
          onClick={() => onPublish(trimmed, true)}
        >
          <LockIcon />
          <span className="pubdlg__opt-label">Publish to GitHub private repository</span>
          <span className="pubdlg__opt-hint">{hint('private')}</span>
        </button>
        <button
          className="pubdlg__opt"
          disabled={!trimmed}
          onClick={() => onPublish(trimmed, false)}
        >
          <GlobeIcon />
          <span className="pubdlg__opt-label">Publish to GitHub public repository</span>
          <span className="pubdlg__opt-hint">{hint('public')}</span>
        </button>
      </div>
    </div>,
    document.body
  )
}

function LockIcon() {
  return (
    <svg className="pubdlg__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="3" y="7" width="10" height="6.5" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function GlobeIcon() {
  return (
    <svg className="pubdlg__icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  )
}
