import type { BoundGroup } from './worktree-reconcile'

/** One checkout the Source Control panel can operate on. */
export interface ScmScope {
  /** 'main' for the project's own checkout, else the bound group's node id. */
  id: string
  label: string
  cwd: string
  kind: 'main' | 'worktree'
}

/** The main checkout first, then one scope per bound worktree. */
export function scmScopes(project: { cwd?: string; name: string }, bound: BoundGroup[]): ScmScope[] {
  if (!project.cwd) return []
  return [
    { id: 'main', label: `${project.name} (main checkout)`, cwd: project.cwd, kind: 'main' },
    ...bound.map((b) => ({
      id: b.groupId,
      label: `${b.worktree.branch} (worktree)`,
      cwd: b.worktree.path,
      kind: 'worktree' as const
    }))
  ]
}

/**
 * The scope to open on: the selected node's bound group, else the main checkout. A selected
 * group with no worktree is not an error — it simply means the main checkout.
 */
export function defaultScmScope(scopes: ScmScope[], selectedGroupId: string | null): ScmScope | undefined {
  const hit = selectedGroupId ? scopes.find((s) => s.id === selectedGroupId) : undefined
  return hit ?? scopes.find((s) => s.id === 'main')
}
