import { useEffect, useState } from 'react'
import type { TmuxStatus } from '@shared/types'
import { localSession } from '../session/localSession'

// "tmux not found" strip: without tmux the app silently degrades to a plain shell — terminals
// don't survive restarts and the mobile companion can't attach — and nothing used to say so
// (one field report ran degraded for months without anyone noticing). Shown every launch until
// tmux is installed; the ✕ hides it for this session only. The install button runs the suggested
// package-manager command in a new terminal node (the gh-sign-in pattern), so the user watches it
// happen. No known package manager → text-only guidance. Hidden on win32 (no native tmux to
// install) and on any fetch error (fail-open, like the ws-bridge stub).
export function TmuxBanner({ onInstall }: { onInstall: (command: string) => void }): JSX.Element | null {
  const [status, setStatus] = useState<TmuxStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let cancelled = false
    // Deliberately the LOCAL session, not useSession(): this banner is about THIS machine's tmux
    // (the host whose terminals lose continuity), never a relay tab's remote host.
    localSession.api.pty
      .tmuxStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!status || status.available || dismissed || status.platform === 'win32') return null

  return (
    <div className="announce-banner announce-banner--warning">
      <span className="announce-banner__dot" />
      <div className="announce-banner__content">
        <span className="announce-banner__title">tmux not found</span>
        <span className="announce-banner__body">
          {status.installCommand
            ? 'Terminals won’t survive restarts and the mobile app can’t attach until tmux is installed.'
            : 'Terminals won’t survive restarts and the mobile app can’t attach. Install tmux with your package manager (e.g. brew install tmux), then restart nodeterm.'}
        </span>
      </div>
      {status.installCommand && (
        <button
          className="announce-banner__btn"
          title={status.installCommand}
          onClick={() => {
            onInstall(status.installCommand!)
            setDismissed(true)
          }}
        >
          Install tmux
        </button>
      )}
      <button className="announce-banner__close" title="Dismiss" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  )
}
