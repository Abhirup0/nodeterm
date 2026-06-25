import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEntitlement } from '../state/entitlement'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'

/**
 * Remote access dialog — a self-contained popup reachable from the project (tab) caret menu, so
 * remote access isn't buried in Settings. Mirrors the Settings RemoteSection flow:
 *  - Host "Allow remote access" (Pro): start → show the single-use pairing offer + copy/stop.
 *  - Non-Pro: hosting is gated — show the upgrade popup (Upgrade → Stripe checkout).
 *  - Client "Connect to a host" (free): paste an offer → open the live mirror.
 * It deliberately does NOT import RemoteSection (which the Settings redesign owns); the small
 * remote IPC flow is duplicated here. A future refactor can hoist it into a shared hook.
 */
export function RemoteAccessDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const isPremium = useEntitlement((s) => s.isPremium)
  const upgrade = useEntitlement((s) => s.upgrade)
  const [hostOffer, setHostOffer] = useState('')
  const [hostBusy, setHostBusy] = useState(false)
  const [error, setError] = useState('')
  const [clientCode, setClientCode] = useState('')
  const [connecting, setConnecting] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const startHosting = async () => {
    setError('')
    setHostBusy(true)
    try {
      const { offer } = await window.nodeTerminal.remoteHost.start()
      setHostOffer(offer)
    } catch (err) {
      setError((err as Error).message)
      setHostBusy(false)
    }
  }
  const stopHosting = async () => {
    await window.nodeTerminal.remoteHost.stop()
    setHostOffer('')
    setHostBusy(false)
  }
  const connect = async () => {
    const code = clientCode.trim()
    if (!code) return
    setError('')
    setConnecting(true)
    try {
      const connectionId = await window.nodeTerminal.remoteClient.connect(code)
      window.dispatchEvent(
        new CustomEvent('nodeterm:open-remote-terminal', { detail: { connectionId } })
      )
      onClose()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setConnecting(false)
    }
  }

  return createPortal(
    <div className="confirm-overlay" onClick={onClose}>
      <div className="remote-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="remote-dialog__head">
          <h3>Remote access</h3>
          <button className="remote-dialog__x" onClick={onClose} title="Close">
            ×
          </button>
        </div>
        <p className="remote-dialog__desc">
          Open terminals that run on another machine you own — end-to-end encrypted over the relay.
          Hosting (sharing this machine) is Pro; connecting to a host is free.
        </p>

        <h4 className="remote-dialog__head4">Allow remote access</h4>
        {isPremium ? (
          hostOffer ? (
            <div className="remote-dialog__block">
              <p className="remote-dialog__hint">Share this pairing code (single use):</p>
              <Input
                className="w-full"
                readOnly
                value={hostOffer}
                onFocus={(e) => e.target.select()}
              />
              <div className="remote-dialog__row">
                <Button onClick={() => window.nodeTerminal.clipboard.writeText(hostOffer)}>
                  Copy code
                </Button>
                <Button onClick={() => void stopHosting()}>Stop sharing</Button>
              </div>
            </div>
          ) : (
            <Button disabled={hostBusy} onClick={() => void startHosting()}>
              {hostBusy ? 'Starting…' : 'Allow remote access'}
            </Button>
          )
        ) : (
          <div className="remote-dialog__block">
            <p className="remote-dialog__hint">
              Sharing this machine requires nodeterm Pro. Connecting to a host you were given a code
              for is free.
            </p>
            <Button onClick={() => void upgrade()}>Upgrade to Pro — $29/mo</Button>
          </div>
        )}

        <h4 className="remote-dialog__head4">Connect to a host</h4>
        <div className="remote-dialog__block">
          <Input
            className="w-full"
            placeholder="paste the host's code"
            value={clientCode}
            onChange={(e) => setClientCode(e.target.value)}
          />
          <Button disabled={connecting || !clientCode.trim()} onClick={() => void connect()}>
            {connecting ? 'Connecting…' : 'Connect'}
          </Button>
        </div>

        {error ? <p className="remote-dialog__err">{error}</p> : null}
      </div>
    </div>,
    document.body
  )
}
