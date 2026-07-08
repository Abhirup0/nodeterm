import { useEffect, useRef, useState } from 'react'
import { toDataURL } from 'qrcode'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { Button } from '@renderer/ui/Button'

const ROWS = {
  pair: {
    title: 'Pair phone',
    keywords: ['phone', 'pair', 'qr', 'ios', 'mobile', 'ssh', 'scan', 'nodeterm']
  }
}
const ENTRIES = Object.values(ROWS)

type Phase = 'idle' | 'waiting' | 'paired' | 'timeout'

export function PhoneSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [qr, setQr] = useState('')
  const [sshOpen, setSshOpen] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Track whether a pairing listener is currently running so unmount can stop it.
  const runningRef = useRef(false)

  const startPairing = async (): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const { payload, sshOpen: open } = await window.nodeTerminal.pairing.start()
      const dataUrl = await toDataURL(payload, { margin: 1, width: 240 })
      setQr(dataUrl)
      setSshOpen(open)
      setPhase('waiting')
      runningRef.current = true
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stopPairing = (): void => {
    if (runningRef.current) {
      runningRef.current = false
      void window.nodeTerminal.pairing.stop()
    }
    setPhase('idle')
    setQr('')
  }

  // Subscribe to the completion event; drives paired/timeout state.
  useEffect(() => {
    const off = window.nodeTerminal.pairing.onDone((result) => {
      runningRef.current = false
      setQr('')
      setPhase(result.ok ? 'paired' : 'timeout')
    })
    return off
  }, [])

  // Stop any in-flight pairing when the section unmounts (settings closed / navigated away).
  useEffect(() => {
    return () => {
      if (runningRef.current) {
        runningRef.current = false
        void window.nodeTerminal.pairing.stop()
      }
    }
  }, [])

  return (
    <SettingsSection
      id="phone"
      title="Phone"
      description="Pair the nodeterm iOS app so it can connect to this machine over your local network — no terminal commands needed."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.pair}>
        <div className="space-y-4">
          <h4 className="text-[13px] font-medium text-text">Pair phone</h4>
          <p className="text-sm text-muted">
            Pair the nodeterm iOS app: scan this QR with your phone. Your phone generates its own
            key on-device — nothing secret leaves this machine except a single-use pairing token.
          </p>

          {phase === 'idle' || phase === 'timeout' ? (
            <div className="space-y-3">
              {phase === 'timeout' ? (
                <p className="text-sm text-muted">
                  Pairing timed out. Start again and scan the new code within two minutes.
                </p>
              ) : null}
              <Button variant="primary" disabled={busy} onClick={() => void startPairing()}>
                {busy ? 'Starting…' : 'Start pairing'}
              </Button>
            </div>
          ) : null}

          {phase === 'waiting' && qr ? (
            <div className="space-y-3">
              <img
                src={qr}
                width={240}
                height={240}
                alt="Pairing QR code"
                className="rounded-lg bg-white p-2"
              />
              <p className="text-sm text-muted">Waiting for your phone… (2 min)</p>
              {!sshOpen ? (
                <p className="text-sm" style={{ color: '#ff9f0a' }}>
                  SSH doesn&apos;t appear to be reachable. Enable Remote Login in System Settings →
                  General → Sharing so your phone can connect after pairing.
                </p>
              ) : null}
              <Button onClick={stopPairing}>Cancel</Button>
            </div>
          ) : null}

          {phase === 'paired' ? (
            <div className="space-y-3">
              <p className="text-sm font-medium" style={{ color: '#30d158' }}>
                ✓ Paired. Your phone can now connect with its own key.
              </p>
              <Button onClick={() => setPhase('idle')}>Pair another phone</Button>
            </div>
          ) : null}

          {error ? (
            <p className="text-sm" style={{ color: '#ff9f0a' }}>
              {error}
            </p>
          ) : null}
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
