import { useEffect, useRef, useState } from 'react'
import type { ClaudeUsage, ClaudeUsageWindow } from '@shared/types'
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
 * Bottom-left Claude usage pill + popover. Renders to the right of the React Flow Controls.
 * States: hidden when 'unavailable'; '···' while first-fetching; '⚠' on error w/o data;
 * last-known data shown on stale/error. Compact pill = mini-bar + "62% 5h · 76% wk".
 */
export function UsageIndicator(): JSX.Element | null {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null)
  const [open, setOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const popRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void window.nodeTerminal.usage.fetch().then(setUsage)
    return window.nodeTerminal.usage.onUpdate(setUsage)
  }, [])

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
          {session && <WindowRow title="Session" w={session} />}
          {weekly && <WindowRow title="Weekly" w={weekly} />}
          {!hasData && <div className="usage-popover__empty">No usage data.</div>}
          {usage.email && (
            <div className="usage-account">
              <div className="usage-account__label">Claude Account</div>
              <div className="usage-account__email">{usage.email}</div>
            </div>
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
