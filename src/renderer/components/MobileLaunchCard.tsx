import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ScenePhone } from './onboarding/scenes'
import { IOS_APP_STORE_URL } from '@renderer/lib/links'

/** One-shot flag: the mobile-launch announcement has been shown and closed (or pre-empted by
 *  the setup tour, whose phone step makes the same pitch to fresh installs). localStorage, not
 *  settings — it is per-machine presentation state, like dismissed announcement banners. */
const MOBILE_LAUNCH_SEEN_KEY = 'nodeterm.seenMobileLaunch'

export function markMobileLaunchSeen(): void {
  try {
    localStorage.setItem(MOBILE_LAUNCH_SEEN_KEY, '1')
  } catch {
    // storage unavailable: worst case the card shows again next launch
  }
}

export function shouldShowMobileLaunch(): boolean {
  try {
    return localStorage.getItem(MOBILE_LAUNCH_SEEN_KEY) == null
  } catch {
    return false
  }
}

/**
 * One-time launch announcement for nodeterm mobile (App Store release): a centered card over
 * the canvas in the promo style — dark, purple glow, the floating phone mockup from the setup
 * tour. Closes for good via the button, Esc, or the backdrop; every path persists the flag.
 */
export function MobileLaunchCard({ onClose }: { onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="mlaunch__backdrop" onClick={onClose}>
      <div
        className="mlaunch"
        role="dialog"
        aria-label="nodeterm mobile is on the App Store"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mlaunch__title">
          Your terminal, <span>everywhere</span>
        </h2>
        <p className="mlaunch__sub">nodeterm mobile is now on the App Store 🎉</p>
        <div className="mlaunch__scene">
          <ScenePhone />
        </div>
        <p className="mlaunch__body">
          Attach to these same live sessions from your phone — watch an agent work, answer a
          &ldquo;needs you&rdquo;, type into any terminal from anywhere. nodeterm stays free and
          open source, developed in the open with the community; the app and its Pro features are
          what fund that work. Your support means everything. ❤️
        </p>
        <div className="mlaunch__actions">
          <button
            className="onb-btn onb-btn--primary"
            autoFocus
            onClick={() => window.nodeTerminal.shell.openExternal(IOS_APP_STORE_URL)}
          >
            Get the iOS app
          </button>
          <button className="onb-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
