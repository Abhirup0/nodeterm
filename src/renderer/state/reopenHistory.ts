import { create } from 'zustand'
import type { ReopenNodeSnapshot } from '@renderer/lib/reopenNode'

/** A single "close" event this session recorded — a project tab close, or a batch of node
 *  deletions from one Delete/×/Cmd+W action. In-memory only: unlike closed-project state
 *  (`project.closed`), which persists, this history resets on app restart — the same
 *  convention a browser's own "reopen closed tab" uses. */
export type ReopenEntry =
  | { kind: 'project'; projectId: string; closedAt: number }
  | { kind: 'nodes'; projectId: string; closedAt: number; nodes: ReopenNodeSnapshot[] }

export const HISTORY_CAP = 10

/** Appends `entry` (most recent last) and drops the oldest entries past `cap`. */
export function pushEntry(stack: ReopenEntry[], entry: ReopenEntry, cap: number): ReopenEntry[] {
  return [...stack, entry].slice(-cap)
}

/** Removes and returns the most recently pushed entry, or `undefined` for an empty stack. */
export function popEntry(stack: ReopenEntry[]): { entry: ReopenEntry | undefined; rest: ReopenEntry[] } {
  if (!stack.length) return { entry: undefined, rest: stack }
  return { entry: stack[stack.length - 1], rest: stack.slice(0, -1) }
}

interface ReopenHistoryState {
  stack: ReopenEntry[]
  push: (entry: ReopenEntry) => void
  /** Pops and returns the most recent entry. Callers that find it stale (project already
   *  reopened another way, or permanently deleted) call this again to keep walking back. */
  popNext: () => ReopenEntry | undefined
}

export const useReopenHistory = create<ReopenHistoryState>((set, get) => ({
  stack: [],
  push: (entry) => set((s) => ({ stack: pushEntry(s.stack, entry, HISTORY_CAP) })),
  popNext: () => {
    const { entry, rest } = popEntry(get().stack)
    if (entry) set({ stack: rest })
    return entry
  }
}))
