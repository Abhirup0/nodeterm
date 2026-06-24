import type React from 'react'
import { useSettingsSearch } from './context'
import { matchesQuery, type SettingsSearchEntry } from './search'

/** Section shell: header + card body. Renders only when it is the active section
 *  (no query) or when at least one of its searchEntries matches (query present). */
export function SettingsSection({
  id,
  title,
  description,
  isActive,
  searchEntries,
  children
}: {
  id: string
  title: string
  description?: string
  isActive: boolean
  searchEntries?: SettingsSearchEntry[]
  children: React.ReactNode
}): React.JSX.Element | null {
  const query = useSettingsSearch()
  const hasQuery = query.trim() !== ''
  if (hasQuery) {
    const anyMatch = !searchEntries || searchEntries.some((e) => matchesQuery(query, e))
    if (!anyMatch) {
      return null
    }
  } else if (!isActive) {
    return null
  }
  return (
    <section id={id} data-settings-section={id} className="space-y-5">
      <div>
        <h2 className="text-[22px] font-semibold tracking-tight text-text">{title}</h2>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      <div className="rounded-xl border border-border bg-white/[0.02] px-5 py-2 shadow-sm">
        {children}
      </div>
    </section>
  )
}
