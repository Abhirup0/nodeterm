import { useEffect } from 'react'

interface WelcomeScreenProps {
  onNewProject: () => void
  onOpenFolder: () => void
  onCloneRepo: () => void
  /**
   * When provided, the screen is dismissable (opened on demand via "+", over existing projects)
   * — adds a close button, Escape, and click-outside. Omitted for the permanent no-projects screen.
   */
  onClose?: () => void
}

/** Start screen with quick actions — shown when there are no projects, or on demand via "+". */
export function WelcomeScreen({ onNewProject, onOpenFolder, onCloneRepo, onClose }: WelcomeScreenProps) {
  useEffect(() => {
    if (!onClose) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="welcome"
      onClick={onClose ? (e) => e.target === e.currentTarget && onClose() : undefined}
    >
      {onClose && (
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 16,
            right: 20,
            background: 'transparent',
            border: 'none',
            color: 'rgba(235,235,245,0.6)',
            fontSize: 26,
            lineHeight: 1,
            cursor: 'pointer'
          }}
        >
          ×
        </button>
      )}
      <div className="welcome__brand">
        <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true">
          <defs>
            <linearGradient id="wtg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#a38dff" />
              <stop offset="1" stopColor="#622994" />
            </linearGradient>
          </defs>
          <path
            d="M13 12 L31 24 L13 36"
            fill="none"
            stroke="url(#wtg)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="13" cy="12" r="3.6" fill="#a38dff" />
          <circle cx="13" cy="36" r="3.6" fill="#a38dff" />
          <circle cx="31" cy="24" r="3.6" fill="#fff" />
          <rect x="33.5" y="32.5" width="10.5" height="5" rx="2.5" fill="#a38dff" />
        </svg>
        <span className="welcome__name">nodeterm</span>
      </div>
      <p className="welcome__tagline">A canvas of terminals. Start a project to begin.</p>

      <div className="welcome__cards">
        <button className="welcome__card" onClick={onNewProject}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <path d="M12 11v5M9.5 13.5h5" />
          </svg>
          <span>New project</span>
        </button>

        <button className="welcome__card" onClick={onOpenFolder}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span>Open folder…</span>
        </button>

        <button className="welcome__card" onClick={onCloneRepo}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3v10M8 9l4 4 4-4" />
            <path d="M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2" />
          </svg>
          <span>Clone repo…</span>
        </button>
      </div>
    </div>
  )
}
