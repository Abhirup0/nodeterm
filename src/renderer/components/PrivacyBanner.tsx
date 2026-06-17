import { useSettings } from '../state/settings'

// One-time, dismissible first-run notice that anonymous usage data is sent (opt-out).
// Shown until the user dismisses it (telemetryNoticeSeen) — reuses the .update-banner styles.
export function PrivacyBanner(): JSX.Element | null {
  const settings = useSettings((s) => s.settings)
  const hydrated = useSettings((s) => s.hydrated)
  const update = useSettings((s) => s.update)
  if (!hydrated || settings.telemetryNoticeSeen) return null

  return (
    <div className="update-banner">
      <span className="update-banner__dot" />
      <span className="update-banner__text">
        nodeterm sends anonymous usage data (version/OS). You can turn this off in Settings.
      </span>
      <button
        className="update-banner__btn"
        onClick={() => update({ telemetryEnabled: false, telemetryNoticeSeen: true })}
      >
        Turn off
      </button>
      <button
        className="update-banner__close"
        title="Dismiss"
        onClick={() => update({ telemetryNoticeSeen: true })}
      >
        ✕
      </button>
    </div>
  )
}
