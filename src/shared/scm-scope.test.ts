import { describe, it, expect } from 'vitest'
import { scmScopes, defaultScmScope } from './scm-scope'
import type { BoundGroup } from './worktree-reconcile'

const project = { cwd: '/repo', name: 'nodeterm' }
const bound = (groupId: string, branch: string, path: string): BoundGroup => ({
  groupId,
  worktree: { repoPath: '/repo', branch, baseRef: 'main', path, createdByApp: true }
})

describe('scmScopes', () => {
  it('always puts the main checkout first', () => {
    const scopes = scmScopes(project, [bound('g1', 'feat', '/wt/feat')])
    expect(scopes[0]).toEqual({ id: 'main', label: 'nodeterm (main checkout)', cwd: '/repo', kind: 'main' })
  })

  it('adds one scope per bound worktree, keyed by group id', () => {
    const scopes = scmScopes(project, [bound('g1', 'feat', '/wt/feat')])
    expect(scopes[1]).toEqual({ id: 'g1', label: 'feat (worktree)', cwd: '/wt/feat', kind: 'worktree' })
  })

  it('returns nothing when the project has no cwd', () => {
    expect(scmScopes({ name: 'x' }, [])).toEqual([])
  })
})

describe('defaultScmScope', () => {
  const scopes = scmScopes(project, [bound('g1', 'feat', '/wt/feat'), bound('g2', 'fix', '/wt/fix')])

  it('picks the scope of the selected group', () => {
    expect(defaultScmScope(scopes, 'g2')?.cwd).toBe('/wt/fix')
  })

  it('falls back to the main checkout with no selection', () => {
    expect(defaultScmScope(scopes, null)?.id).toBe('main')
  })

  // A selected group that is not bound is not an error — it just means "main checkout".
  it('falls back to the main checkout when the selected group has no worktree', () => {
    expect(defaultScmScope(scopes, 'g-unbound')?.id).toBe('main')
  })
})
