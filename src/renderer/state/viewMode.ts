import { create } from 'zustand'

// Which view each project shows (canvas or kanban) — PERSONAL, per machine: persisted in
// localStorage, deliberately never in the git-shared .nodeterm/project.json (spec rule).
// Only 'kanban' entries are stored; an absent project id means canvas (the default).

export const PROJECT_VIEW_KEY = 'nodeterm.projectView'

/** Parses the persisted map, keeping only valid 'kanban' entries. Exported for tests. */
export function parseViewMap(raw: string | null): Record<string, 'kanban'> {
  try {
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, 'kanban'> = {}
    for (const [id, v] of Object.entries(parsed)) if (v === 'kanban') out[id] = 'kanban'
    return out
  } catch {
    return {}
  }
}

function save(v: Record<string, 'kanban'>): void {
  try {
    localStorage.setItem(PROJECT_VIEW_KEY, JSON.stringify(v))
  } catch {
    /* quota/private-mode: the view choice is a nicety, never fail the UI */
  }
}

interface ViewModeState {
  viewByProject: Record<string, 'kanban'>
  toggle(projectId: string): void
}

export const useViewMode = create<ViewModeState>((set) => ({
  // localStorage guard: this module is also imported by node-environment vitest suites.
  viewByProject: parseViewMap(
    typeof localStorage === 'undefined' ? null : localStorage.getItem(PROJECT_VIEW_KEY)
  ),
  toggle: (projectId) =>
    set((s) => {
      const next = { ...s.viewByProject }
      if (next[projectId]) delete next[projectId]
      else next[projectId] = 'kanban'
      if (typeof localStorage !== 'undefined') save(next)
      return { viewByProject: next }
    })
}))

/** True when the given project currently shows the kanban board (read outside React —
 *  keydown handlers use this so they need no store subscription/deps). */
export function isKanbanOpen(projectId: string): boolean {
  return !!projectId && !!useViewMode.getState().viewByProject[projectId]
}
