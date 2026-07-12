import { beforeEach, describe, expect, it, vi } from 'vitest'

// The node test environment has no DOM, so shim an in-memory localStorage (matching the setup
// in agentStatus.persist.test.ts). The store's load()/save() are try/catch-guarded, so the
// import below runs fine even before this stub is installed.
function memStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map(Object.entries(seed))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}
vi.stubGlobal('localStorage', memStorage())

import { useExplorer, EXPLORER_EXPANDED_KEY } from './explorer'

beforeEach(() => {
  localStorage.clear()
  useExplorer.setState({ expandedByProject: {} })
})

describe('explorer expansion store', () => {
  it('expands and collapses per project', () => {
    useExplorer.getState().setExpanded('p1', '/repo/src', true)
    expect(useExplorer.getState().isExpanded('p1', '/repo/src')).toBe(true)
    expect(useExplorer.getState().isExpanded('p2', '/repo/src')).toBe(false)
    useExplorer.getState().setExpanded('p1', '/repo/src', false)
    expect(useExplorer.getState().isExpanded('p1', '/repo/src')).toBe(false)
  })

  it('expandMany adds without duplicates', () => {
    useExplorer.getState().setExpanded('p1', '/repo/src', true)
    useExplorer.getState().expandMany('p1', ['/repo/src', '/repo/src/lib'])
    expect(useExplorer.getState().expandedByProject['p1']).toEqual(['/repo/src', '/repo/src/lib'])
  })

  it('persists to localStorage and hydrates from it', () => {
    useExplorer.getState().setExpanded('p1', '/repo/src', true)
    expect(JSON.parse(localStorage.getItem(EXPLORER_EXPANDED_KEY)!)).toEqual({ p1: ['/repo/src'] })
  })
})
