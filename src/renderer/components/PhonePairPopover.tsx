import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Switch } from '@renderer/ui/Switch'
import { useSettings } from '@renderer/state/settings'
import { useEntitlement } from '@renderer/state/entitlement'
import { useUpgradeGate } from '@renderer/state/upgradeGate'
import { usePhonePairing } from './settings/usePhonePairing'

/** Same deep link the Phone settings section uses for the Remote Login toggle. */
const REMOTE_LOGIN_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preferences.sharing?Services_RemoteLogin'
const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

/**
 * Quick phone pairing, anchored under the top-right phone button: opens straight into a live QR
 * (no "Start pairing" click — that's the whole point of the shortcut), with the standing
 * "Reach this Mac from anywhere" toggle below and a link into the full Phone settings.
 * Closing the popover stops an unfinished pairing (the shared hook's unmount rule).
 */
export function PhonePairPopover({
  anchor,
  onClose,
  onOpenSettings
}: {
  /** Viewport rect of the phone button — the popover right-aligns under it. */
  anchor: { right: number; bottom: number }
  onClose: () => void
  onOpenSettings: () => void
}): React.JSX.Element {
  const { phase, qr, sshOpen, sshHealed, error, busy, start } = usePhonePairing()

  const isPremium = useEntitlement((s) => s.isPremium)
  const phoneAccessEnabled = useSettings((s) => s.settings.phoneAccessEnabled)
  const updateSettings = useSettings((s) => s.update)

  const togglePhoneAccess = (next: boolean): void => {
    updateSettings({ phoneAccessEnabled: next })
    // Start/stop the standing relay host immediately (main also honors the Pro gate).
    window.nodeTerminal.remoteHost.setPhoneAccess(next)
  }

  // Straight into the QR on open (local-network pairing is free — no gate here).
  useEffect(() => {
    void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run exactly once, on open
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <>
      <div className="phone-pair__backdrop" onClick={onClose} />
      <div
        className="phone-pair"
        style={{ top: anchor.bottom + 8, right: Math.max(8, window.innerWidth - anchor.right) }}
        role="dialog"
        aria-label="Pair phone"
      >
        <div className="phone-pair__title">Pair your phone</div>

        {phase === 'waiting' && qr ? (
          <>
            <img src={qr} width={208} height={208} alt="Pairing QR code" className="phone-pair__qr" />
            <div className="phone-pair__hint">Scan with the nodeterm iOS app · waiting (2 min)</div>
            {!sshOpen ? (
              <div className="phone-pair__warn">
                SSH isn&apos;t reachable — turn on <strong>Remote Login</strong>
                {isMac ? (
                  <>
                    {' '}
                    (
                    <button
                      className="phone-pair__link"
                      onClick={() => window.nodeTerminal.shell.openExternal(REMOTE_LOGIN_SETTINGS_URL)}
                    >
                      System Settings
                    </button>
                    &nbsp;— watching, this clears itself).
                  </>
                ) : (
                  '.'
                )}
              </div>
            ) : sshHealed ? (
              <div className="phone-pair__ok">✓ Remote Login is on.</div>
            ) : null}
          </>
        ) : phase === 'paired' ? (
          <div className="phone-pair__ok">✓ Paired — your phone can now connect.</div>
        ) : phase === 'timeout' ? (
          <>
            <div className="phone-pair__hint">Pairing timed out.</div>
            <button className="phone-pair__btn" disabled={busy} onClick={() => void start()}>
              Show a new code
            </button>
          </>
        ) : (
          <div className="phone-pair__hint">{busy ? 'Starting…' : error || 'Starting…'}</div>
        )}
        {error && phase !== 'idle' ? <div className="phone-pair__warn">{error}</div> : null}

        <div className="phone-pair__divider" />

        <div className="phone-pair__row">
          <div className="phone-pair__row-text">
            <div className="phone-pair__row-title">
              Reach this Mac from anywhere
              {!isPremium && <span className="phone-pair__pro">PRO</span>}
            </div>
            <div className="phone-pair__row-sub">E2E encrypted over the relay — not just your LAN.</div>
          </div>
          <Switch
            checked={isPremium && phoneAccessEnabled}
            onChange={(next) => {
              if (!isPremium) {
                useUpgradeGate.getState().show('Remote access from your phone')
                return
              }
              togglePhoneAccess(next)
            }}
            ariaLabel="Reach this Mac from anywhere"
          />
        </div>

        <button className="phone-pair__link phone-pair__footer" onClick={onOpenSettings}>
          All phone settings…
        </button>
      </div>
    </>,
    document.body
  )
}
