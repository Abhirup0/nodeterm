import { useEffect, useState } from 'react'

// Thin strip under the tab bar that announces a newer version. While the update downloads
// it shows "Downloading…"; once ready it offers "Restart to update" (→ updates.restart()).
// In dev the main process never emits these events, so the banner stays hidden.
export function UpdateBanner(): JSX.Element | null {
  const [version, setVersion] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const offAvailable = window.nodeTerminal.updates.onAvailable((info) => {
      setVersion(info.version)
      setReady(false)
      setDismissed(false)
    })
    const offDownloaded = window.nodeTerminal.updates.onDownloaded((info) => {
      setVersion(info.version)
      setReady(true)
    })
    return () => {
      offAvailable()
      offDownloaded()
    }
  }, [])

  if (!version || dismissed) return null

  return (
    <div className="update-banner">
      <span className="update-banner__dot" />
      <span className="update-banner__text">
        {ready
          ? `nodeterm ${version} is ready to install`
          : `Downloading nodeterm ${version}…`}
      </span>
      {ready && (
        <button
          className="update-banner__btn"
          onClick={() => window.nodeTerminal.updates.restart()}
        >
          Restart to update
        </button>
      )}
      <button
        className="update-banner__close"
        title="Dismiss"
        onClick={() => setDismissed(true)}
      >
        ✕
      </button>
    </div>
  )
}
