import { create } from 'zustand'

// Which Explorer directories are expanded, per project — persisted so the tree comes back
// exactly as the user left it after closing/reopening the drawer or restarting the app.
// Values are absolute dir paths (remote paths for SSH projects). Stale paths (deleted dirs,
// removed projects) are harmless: a path that never renders never matters.

export const EXPLORER_EXPANDED_KEY = 'nodeterm.explorerExpanded'

interface ExplorerState {
  expandedByProject: Record<string, string[]>
  isExpanded(projectId: string, path: string): boolean
  setExpanded(projectId: string, path: string, open: boolean): void
  expandMany(projectId: string, paths: string[]): void
}

function load(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(EXPLORER_EXPANDED_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, string[]>) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function save(v: Record<string, string[]>): void {
  try {
    localStorage.setItem(EXPLORER_EXPANDED_KEY, JSON.stringify(v))
  } catch {
    /* quota/private-mode: expansion is a nicety, never fail the UI */
  }
}

export const useExplorer = create<ExplorerState>((set, get) => ({
  expandedByProject: load(),
  isExpanded: (projectId, path) => (get().expandedByProject[projectId] ?? []).includes(path),
  setExpanded: (projectId, path, open) =>
    set((s) => {
      const cur = s.expandedByProject[projectId] ?? []
      const next = open ? (cur.includes(path) ? cur : [...cur, path]) : cur.filter((p) => p !== path)
      const expandedByProject = { ...s.expandedByProject, [projectId]: next }
      save(expandedByProject)
      return { expandedByProject }
    }),
  expandMany: (projectId, paths) =>
    set((s) => {
      const cur = s.expandedByProject[projectId] ?? []
      const next = [...cur, ...paths.filter((p) => !cur.includes(p))]
      const expandedByProject = { ...s.expandedByProject, [projectId]: next }
      save(expandedByProject)
      return { expandedByProject }
    })
}))
