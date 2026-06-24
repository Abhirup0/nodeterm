import type React from 'react'
import { useSettingsSearch } from './context'
import { matchesQuery, type SettingsSearchEntry } from './search'

/** Renders its children only when the current query matches this row's metadata. */
export function SearchableRow({
  title,
  description,
  keywords,
  children
}: SettingsSearchEntry & { children: React.ReactNode }): React.JSX.Element | null {
  const query = useSettingsSearch()
  if (!matchesQuery(query, { title, description, keywords })) {
    return null
  }
  return <>{children}</>
}
