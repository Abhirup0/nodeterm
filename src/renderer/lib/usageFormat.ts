// Pure formatting helpers for the usage indicator.

/** "just now" / "5m ago" / "2h ago". */
export function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

/** "Resets now" / "Resets in 1h 2m" / "Resets in 2d 4h". */
export function formatResetCountdown(resetsAt: number | null): string {
  if (resetsAt == null) return ''
  const ms = resetsAt - Date.now()
  if (ms <= 0) return 'Resets now'
  const totalMins = Math.floor(ms / 60_000)
  if (totalMins < 60) return `Resets in ${totalMins}m`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `Resets in ${days}d ${remHours}h` : `Resets in ${days}d`
  }
  return mins > 0 ? `Resets in ${hours}h ${mins}m` : `Resets in ${hours}h`
}

/** Bar color by remaining quota: green > 40%, yellow 20–40%, red < 20%. */
export function barColor(leftPercent: number): string {
  if (leftPercent > 40) return '#30d158'
  if (leftPercent >= 20) return '#ffd60a'
  return '#ff453a'
}
