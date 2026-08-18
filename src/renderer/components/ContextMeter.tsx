import { useEffect, useRef, useState } from 'react'
import { useContextWindow } from '../state/contextWindow'
import { useSettings } from '../state/settings'
import { barFillPercent, contextFillColor, formatModelLabel, formatTimeAgo, percentNumber, percentText } from '../lib/usageFormat'

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
  const percentMode = useSettings((s) => s.settings.usagePercentMode)
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
  // The NUMBER honours the used/remaining display setting; the bar and its color stay keyed to
  // context FILL, so the severity colors keep meaning the same thing in both modes (issue #78).
  const pct = percentNumber(usage.usedPercent, percentMode)
  const color = contextFillColor(usage.usedPercent)
  const modelLabel = formatModelLabel(usage.model)

  return (
    <div className="ctx-meter nodrag" ref={ref}>
      {open && (
        <div className="ctx-popover">
          <div className="ctx-popover__title">Context</div>
          <div className="ctx-bar">
            <div className="ctx-bar__fill" style={{ width: `${barFillPercent(usage.usedPercent, percentMode)}%`, background: color }} />
          </div>
          <div className="ctx-popover__meta">
            ~{formatTokens(usage.usedTokens)} / {formatTokens(usage.windowTokens)} tokens
          </div>
          <div className="ctx-popover__sub">
            {/* No model read ⇒ say nothing. This used to fall back to the literal 'claude', which
                was harmless while the meter was claude-only and became a mislabel once codex and
                gemini joined USAGE_CAPABLE — a codex popover would have claimed to be claude. */}
            {usage.model ? `${usage.model} · ` : ''}Updated {formatTimeAgo(usage.updatedAt)}
          </div>
        </div>
      )}
      <button
        className="ctx-pill"
        title={`Context window — ${percentText(usage.usedPercent, percentMode)}`}
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
      >
        {modelLabel && <span className="ctx-pill__model">{modelLabel}</span>}
        <span className="ctx-pill__bar">
          <span className="ctx-pill__fill" style={{ width: `${barFillPercent(usage.usedPercent, percentMode)}%`, background: color }} />
        </span>
        <span className="ctx-pill__num">{pct}%</span>
      </button>
    </div>
  )
}
