import { create } from 'zustand'

export interface HistoryEntry {
  url: string
  title: string
  ts: number
}

export const HISTORY_CAP = 100
const KEY = 'nodeterm.browserHistory'

/** Prepend `entry`, drop any existing entry with the same url (a revisit bumps to top), cap length. */
export function addEntry(list: HistoryEntry[], entry: HistoryEntry, cap: number): HistoryEntry[] {
  return [entry, ...list.filter((e) => e.url !== entry.url)].slice(0, cap)
}

function load(): HistoryEntry[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : []
  } catch {
    return []
  }
}

interface HistoryState {
  entries: HistoryEntry[]
  /** Record a visited page. Ignores non-http(s) urls (e.g. about:blank) so the start page isn't logged. */
  record: (url: string, title: string) => void
  recent: (n: number) => HistoryEntry[]
}

export const useBrowserHistory = create<HistoryState>((set, get) => ({
  entries: load(),
  record: (url, title) => {
    if (!/^https?:\/\//i.test(url)) return
    const next = addEntry(get().entries, { url, title: title || url, ts: Date.now() }, HISTORY_CAP)
    set({ entries: next })
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* best-effort */
    }
  },
  recent: (n) => get().entries.slice(0, n)
}))
