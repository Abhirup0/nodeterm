export interface SettingsSearchEntry {
  title: string
  description?: string
  keywords?: string[]
}

/** Case-insensitive substring match over the entry's title, description, and keywords.
 *  An empty/whitespace query matches everything. */
export function matchesQuery(query: string, entry: SettingsSearchEntry): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') {
    return true
  }
  const haystack = [entry.title, entry.description ?? '', ...(entry.keywords ?? [])]
    .join(' ')
    .toLowerCase()
  return haystack.includes(q)
}
