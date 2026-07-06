import { useEffect, useMemo, useRef, useState } from 'react'
import type { ClaudeUsage, ClaudeUsageWindow } from '@shared/types'
import { useSettings } from '../state/settings'
import { barColor, formatResetCountdown, formatTimeAgo } from '../lib/usageFormat'

const SESSION_LABEL = '5h'
const WEEKLY_LABEL = 'wk'

/** A single window row in the popover: bar, "% left", reset countdown. */
function WindowRow({ title, w }: { title: string; w: ClaudeUsageWindow }) {
  const left = Math.round(w.leftPercent)
  return (
    <div className="usage-row">
      <div className="usage-row__title">{title}</div>
      <div className="usage-bar">
        <div className="usage-bar__fill" style={{ width: `${w.leftPercent}%`, background: barColor(w.leftPercent) }} />
      </div>
      <div className="usage-row__meta">
        <span>{left}% left</span>
        <span>{formatResetCountdown(w.resetsAt)}</span>
      </div>
    </div>
  )
}

/**
 * One account's session/weekly bars under a label, for the multi-account popover. Reuses
 * WindowRow's markup — `u` is null while its on-demand fetch is in flight.
 */
function AccountUsageBlock({ label, email, u }: { label: string; email?: string; u: ClaudeUsage | null }) {
  return (
    <div className="usage-account">
      <div className="usage-account__label">{label}</div>
      {(email ?? u?.email) && <div className="usage-account__email">{email ?? u?.email}</div>}
      {u?.session && <WindowRow title="Session" w={u.session} />}
      {u?.weekly && <WindowRow title="Weekly" w={u.weekly} />}
      {u && !u.session && !u.weekly && <div className="usage-popover__empty">No usage data.</div>}
      {!u && <div className="usage-popover__empty usage-pill__pulse">···</div>}
    </div>
  )
}

/**
 * Bottom-left Claude usage pill + popover. Renders to the right of the React Flow Controls.
 * States: hidden when 'unavailable'; '···' while first-fetching; '⚠' on error w/o data;
 * last-known data shown on stale/error. Compact pill = mini-bar + "62% 5h · 76% wk".
 */
export function UsageIndicator(): JSX.Element | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [acctUsage, setAcctUsage] = useState<Record<string, ClaudeUsage | null>>({})
  const popRef = useRef<HTMLDivElement>(null)

  const claudeAccounts = useSettings((s) => s.settings.claudeAccounts)
  // Local logged-in accounts get their own popover row; skip pending logins + remote (host) ones.
  const accounts = useMemo(
    () => claudeAccounts.filter((a) => !a.pending && !a.host),
    [claudeAccounts]
  )

  useEffect(() => {
    void window.nodeTerminal.usage.fetch().then(setUsage)
    return window.nodeTerminal.usage.onUpdate(setUsage)
  }, [])

  // Fetch each account's usage on demand when the popover opens (system row uses `usage`).
  useEffect(() => {
    if (!open || accounts.length === 0) return
    let cancelled = false
    for (const a of accounts) {
      void window.nodeTerminal.usage.fetch(a.id).then((u) => {
        if (!cancelled) setAcctUsage((m) => ({ ...m, [a.id]: u }))
      })
    }
    return () => {
      cancelled = true
    }
  }, [open, accounts])

  // Close the popover on an outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!usage || usage.status === 'unavailable') return null

  const { session, weekly, status } = usage
  const hasData = !!session || !!weekly
  const fetching = refreshing
  const isError = status === 'error'

  const refresh = async (e: React.MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (refreshing) return
    setRefreshing(true)
    try {
      setUsage(await window.nodeTerminal.usage.refresh())
    } finally {
      setRefreshing(false)
    }
  }

  let pillBody: JSX.Element
  if (!hasData && fetching) {
    pillBody = <span className="usage-pill__dim usage-pill__pulse">···</span>
  } else if (!hasData && isError) {
    pillBody = <span className="usage-pill__dim">⚠</span>
  } else {
    pillBody = (
      <>
        {session && (
          <span className="usage-pill__minibar" aria-hidden>
            <span
              className="usage-pill__minibar-fill"
              style={{ width: `${session.leftPercent}%`, background: barColor(session.leftPercent) }}
            />
          </span>
        )}
        {session && (
          <span className="usage-pill__num">
            {Math.round(session.leftPercent)}% {SESSION_LABEL}
          </span>
        )}
        {session && weekly && <span className="usage-pill__sep">·</span>}
        {weekly && (
          <span className="usage-pill__num">
            {Math.round(weekly.leftPercent)}% {WEEKLY_LABEL}
          </span>
        )}
        {isError && hasData && <span className="usage-pill__dim">⚠</span>}
      </>
    )
  }

  return (
    <div className="usage-indicator" ref={popRef}>
      {open && (
        <div className="usage-popover">
          <div className="usage-popover__head">
            <span className="usage-popover__title">✦ Claude</span>
            <span className="usage-popover__ago">Updated {formatTimeAgo(usage.updatedAt)}</span>
          </div>
          {accounts.length > 0 ? (
            <>
              <AccountUsageBlock label="System" u={usage} />
              {accounts.map((a) => (
                <AccountUsageBlock key={a.id} label={a.label} email={a.email} u={acctUsage[a.id] ?? null} />
              ))}
            </>
          ) : (
            <>
              {session && <WindowRow title="Session" w={session} />}
              {weekly && <WindowRow title="Weekly" w={weekly} />}
              {!hasData && <div className="usage-popover__empty">No usage data.</div>}
              {usage.email && (
                <div className="usage-account">
                  <div className="usage-account__label">Claude Account</div>
                  <div className="usage-account__email">{usage.email}</div>
                </div>
              )}
            </>
          )}
        </div>
      )}
      <button className="usage-pill" onClick={() => setOpen((v) => !v)} title="Claude usage">
        <span className="usage-pill__icon">✦</span>
        {pillBody}
      </button>
      <button
        className={`usage-refresh${fetching ? ' spin' : ''}`}
        onClick={refresh}
        disabled={refreshing}
        title="Refresh usage"
      >
        ⟳
      </button>
    </div>
  )
}
