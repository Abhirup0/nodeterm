import { useEffect, useRef, useState } from 'react'
import { useContextWindow } from '../state/contextWindow'
import { formatTimeAgo } from '../lib/usageFormat'

/** Fullness scale (inverse of the usage indicator): green low, yellow mid, red near-full. */
function meterColor(usedPercent: number): string {
  if (usedPercent > 85) return '#ff453a'
  if (usedPercent >= 60) return '#ffd60a'
  return '#30d158'
}

/** Humanize a token count: 48000 → "48k", 1_000_000 → "1M", 850 → "850". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1)).toString()}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * Per-Claude-node context-window meter. A small header pill (mini-bar + "NN%") that toggles
 * a popover with token figures and model. Renders nothing until the session has usage data.
 */
export function ContextMeter({ sessionId }: { sessionId: string | null }): JSX.Element | null {
  const usage = useContextWindow((s) => (sessionId ? s.bySessionId[sessionId] : undefined))
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  if (!usage) return null
  const pct = Math.round(usage.usedPercent)
  const color = meterColor(usage.usedPercent)

  return (
    <div className="ctx-meter nodrag" ref={ref}>
      {open && (
        <div className="ctx-popover">
          <div className="ctx-popover__title">Context</div>
          <div className="ctx-bar">
            <div className="ctx-bar__fill" style={{ width: `${usage.usedPercent}%`, background: color }} />
          </div>
          <div className="ctx-popover__meta">
            ~{formatTokens(usage.usedTokens)} / {formatTokens(usage.windowTokens)} tokens
          </div>
          <div className="ctx-popover__sub">
            {usage.model ?? 'claude'} · Updated {formatTimeAgo(usage.updatedAt)}
          </div>
        </div>
      )}
      <button
        className="ctx-pill"
        title="Context window"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        <span className="ctx-pill__bar">
          <span className="ctx-pill__fill" style={{ width: `${usage.usedPercent}%`, background: color }} />
        </span>
        <span className="ctx-pill__num">{pct}%</span>
      </button>
    </div>
  )
}
