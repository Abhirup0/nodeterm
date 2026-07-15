import { useEffect } from 'react'
import { useRelayQuota } from '../state/relayQuota'
import { useEntitlement } from '../state/entitlement'

/**
 * Free-tier remote-access meter (spec 2026-07-15 §4): hidden for Pro and below 2 uses
 * (the 1st use of a month is deliberately silent), informative from 2/5, and an upgrade
 * CTA once the month is exhausted.
 *
 * Reuses the `.announce-banner` styles: the base (accent) style is the informative state,
 * `--warning` is the exhausted state.
 */
export function RelayQuotaBanner(): JSX.Element | null {
  const status = useRelayQuota((s) => s.status)
  const hydrate = useRelayQuota((s) => s.hydrate)
  const upgrade = useEntitlement((s) => s.upgrade)
  useEffect(() => {
    void hydrate()
  }, [hydrate])
  if (!status || status.unlimited || status.used < 2) return null
  const exhausted = status.used >= status.limit
  return (
    <div className={`announce-banner ${exhausted ? 'announce-banner--warning' : ''}`}>
      <span className="announce-banner__dot" />
      <div className="announce-banner__content">
        {exhausted
          ? `Remote access limit reached — ${status.used}/${status.limit} this month. Pro is unlimited.`
          : `Remote access ${status.used}/${status.limit} this month.`}
      </div>
      {exhausted ? (
        <button className="announce-banner__btn" onClick={() => void upgrade()}>
          Upgrade
        </button>
      ) : null}
    </div>
  )
}
