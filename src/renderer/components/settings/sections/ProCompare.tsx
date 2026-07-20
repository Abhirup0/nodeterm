import { useEffect } from 'react'
import { useRelayQuota } from '../../../state/relayQuota'

const CORE = [
  'Unlimited local terminals & canvas',
  'Unlimited SSH projects',
  'Groups, worktrees, git & diff',
  'Agent nodes (Claude / Codex / Gemini)',
  'QR phone pairing on your LAN'
]
const PRO = [
  'Unlimited remote access from your phone',
  'Standing phone host (reachable anywhere)',
  'nodeterm mobile Pro included',
  '3 team seats included (extra seats $5/seat/mo)'
]

/** Core vs Pro comparison + the live free-tier remote-access meter. */
export function ProCompare(): React.JSX.Element {
  const status = useRelayQuota((s) => s.status)
  const hydrate = useRelayQuota((s) => s.hydrate)
  useEffect(() => {
    void hydrate()
  }, [hydrate])
  return (
    <div className="grid grid-cols-2 gap-4 text-sm">
      <div className="space-y-2">
        <h4 className="text-[13px] font-medium text-muted">Core — free forever</h4>
        {CORE.map((f) => (
          <p key={f} className="text-text">
            ✓ {f}
          </p>
        ))}
        {status && !status.unlimited ? (
          <p className="text-muted">
            ✓ Remote access — {status.used}/{status.limit} used this month
          </p>
        ) : null}
      </div>
      <div className="space-y-2">
        <h4 className="text-[13px] font-medium" style={{ color: 'var(--accent)' }}>
          Pro
        </h4>
        <p className="text-text">✓ Everything in Core</p>
        {PRO.map((f) => (
          <p key={f} className="text-text">
            ✓ {f}
          </p>
        ))}
      </div>
    </div>
  )
}
