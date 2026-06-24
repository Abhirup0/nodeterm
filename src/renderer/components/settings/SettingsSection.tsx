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
    <section id={id} data-settings-section={id} className="space-y-6">
      <div className="border-b border-border pb-5">
        <h2 className="text-[28px] font-bold leading-tight tracking-tight text-text">{title}</h2>
        {description ? (
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      <div className="divide-y divide-border/60 rounded-2xl border border-border bg-white/[0.02] px-6 shadow-sm [&>*]:py-5">
        {children}
      </div>
    </section>
  )
}
