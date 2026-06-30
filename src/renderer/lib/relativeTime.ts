// Short relative time label ("just now" / "5m ago" / "3h ago" / "2d ago") for palette hints.
export function relativeTime(ms: number, nowMs: number): string {
  const diff = Math.max(0, nowMs - ms)
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  return `${Math.floor(hr / 24)}d ago`
}
