import { useCallback, useEffect, useRef, useState } from 'react'
import { toDataURL } from 'qrcode'
import type { PairedDevice } from '@shared/types'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { ConfirmDialog } from '../../ConfirmDialog'
import { Button } from '@renderer/ui/Button'
import { Switch } from '@renderer/ui/Switch'
import { useSettings } from '@renderer/state/settings'
import { useEntitlement } from '@renderer/state/entitlement'

const ROWS = {
  remote: {
    title: 'Remote access from your phone',
    keywords: ['phone', 'remote', 'anywhere', 'relay', 'encrypted', 'pro', 'access', 'cellular']
  },
  pair: {
    title: 'Pair phone',
    keywords: ['phone', 'pair', 'qr', 'ios', 'mobile', 'ssh', 'scan', 'nodeterm']
  },
  devices: {
    title: 'Paired devices',
    keywords: ['phone', 'device', 'devices', 'paired', 'revoke', 'ios', 'iphone', 'remove']
  }
}
const ENTRIES = Object.values(ROWS)

/** Format an epoch-ms pairing time as a short local date. */
function formatPairedAt(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  })
}

type Phase = 'idle' | 'waiting' | 'paired' | 'timeout'

/** How often the Remote Login warning re-probes sshd while it is showing. */
const SSH_RECHECK_MS = 2000

/** Deep link straight to System Settings → General → Sharing (the Remote Login toggle lives
 *  there). The `Services_RemoteLogin` query selected the service in the pre-Ventura prefpane and
 *  is harmless on newer macOS, which opens the Sharing pane either way. macOS-only. */
const REMOTE_LOGIN_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preferences.sharing?Services_RemoteLogin'

/** The pairing host is this machine, so the renderer's own UA answers "is this a Mac?". */
const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

export function PhoneSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const [qr, setQr] = useState('')
  const [sshOpen, setSshOpen] = useState(true)
  // Went from unreachable → reachable while the warning was showing: show a green confirmation
  // instead of silently dropping the warning (the user just flipped a toggle; acknowledge it).
  const [sshHealed, setSshHealed] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [devices, setDevices] = useState<PairedDevice[]>([])
  const [pendingRevoke, setPendingRevoke] = useState<PairedDevice | null>(null)
  // Track whether a pairing listener is currently running so unmount can stop it.
  const runningRef = useRef(false)

  const isPremium = useEntitlement((s) => s.isPremium)
  const phoneAccessEnabled = useSettings((s) => s.settings.phoneAccessEnabled)
  const updateSettings = useSettings((s) => s.update)

  const togglePhoneAccess = (next: boolean): void => {
    updateSettings({ phoneAccessEnabled: next })
    // Start/stop the standing relay host immediately (main also honors the Pro gate).
    window.nodeTerminal.remoteHost.setPhoneAccess(next)
  }

  const refreshDevices = useCallback(async (): Promise<void> => {
    try {
      setDevices(await window.nodeTerminal.pairing.listDevices())
    } catch {
      // leave the last-known list on a transient read error
    }
  }, [])

  // Live re-check while the Remote Login warning is visible: the initial probe runs once at
  // pairing start, so without this the warning could never clear — the user enables Remote Login
  // in System Settings and nothing changes on screen. Poll only in that exact state (waiting +
  // unreachable); the interval dies with the warning.
  useEffect(() => {
    if (phase !== 'waiting' || sshOpen) return
    let cancelled = false
    const timer = setInterval(() => {
      void window.nodeTerminal.pairing
        .probeSsh()
        .then((open) => {
          if (!cancelled && open) {
            setSshOpen(true)
            setSshHealed(true)
          }
        })
        .catch(() => {
          // transient probe error: keep the warning, try again on the next tick
        })
    }, SSH_RECHECK_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [phase, sshOpen])

  const startPairing = async (): Promise<void> => {
    setError('')
    setBusy(true)
    try {
      const { payload, sshOpen: open } = await window.nodeTerminal.pairing.start()
      const dataUrl = await toDataURL(payload, { margin: 1, width: 240 })
      setQr(dataUrl)
      setSshOpen(open)
      setSshHealed(false)
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
      if (result.ok) void refreshDevices()
    })
    return off
  }, [refreshDevices])

  // Load the paired-device list on mount.
  useEffect(() => {
    void refreshDevices()
  }, [refreshDevices])

  const revokeDevice = async (device: PairedDevice): Promise<void> => {
    setPendingRevoke(null)
    try {
      await window.nodeTerminal.pairing.revokeDevice(device.id)
    } finally {
      void refreshDevices()
    }
  }

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
      <SearchableRow {...ROWS.remote}>
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h4 className="text-[13px] font-medium text-text">Remote access from your phone</h4>
              <p className="mt-1 text-sm text-muted">
                Reach this Mac from anywhere — not just your local network — end-to-end encrypted
                over the relay. Your paired phone connects through the relay; the connection is
                verified with a code the first time.
              </p>
            </div>
            {isPremium ? (
              <Switch
                checked={phoneAccessEnabled}
                onChange={togglePhoneAccess}
                ariaLabel="Remote access from your phone"
              />
            ) : null}
          </div>
          {!isPremium ? (
            <p className="text-sm text-muted">
              Remote access from anywhere requires nodeterm Pro. Pairing over your local network is
              free — set it up below.
            </p>
          ) : null}
        </div>
      </SearchableRow>

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
                <div className="space-y-2">
                  <p className="text-sm" style={{ color: '#ff9f0a' }}>
                    SSH doesn&apos;t appear to be reachable — your phone won&apos;t be able to
                    connect after pairing. Turn on <strong>Remote Login</strong>
                    {isMac ? ' (watching — this notice clears by itself once it is on).' : '.'}
                  </p>
                  {isMac ? (
                    <Button onClick={() => window.nodeTerminal.shell.openExternal(REMOTE_LOGIN_SETTINGS_URL)}>
                      Open System Settings
                    </Button>
                  ) : null}
                </div>
              ) : sshHealed ? (
                <p className="text-sm" style={{ color: '#30d158' }}>
                  ✓ Remote Login is on — your phone can connect after pairing.
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

      <SearchableRow {...ROWS.devices}>
        <div className="space-y-3">
          <h4 className="text-[13px] font-medium text-text">Paired devices</h4>
          {devices.length === 0 ? (
            <p className="text-sm text-muted">No devices paired yet</p>
          ) : (
            <ul className="space-y-2">
              {devices.map((device) => (
                <li
                  key={device.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-text">{device.name}</div>
                    {device.pairedAt ? (
                      <div className="text-[12px] text-muted">
                        Paired {formatPairedAt(device.pairedAt)}
                      </div>
                    ) : null}
                  </div>
                  <Button onClick={() => setPendingRevoke(device)}>Revoke</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </SearchableRow>

      {pendingRevoke ? (
        <ConfirmDialog
          message={`Revoke “${pendingRevoke.name}”? Its key is removed from this machine and it will no longer be able to connect.`}
          confirmLabel="Revoke"
          onConfirm={() => void revokeDevice(pendingRevoke)}
          onCancel={() => setPendingRevoke(null)}
        />
      ) : null}
    </SettingsSection>
  )
}
