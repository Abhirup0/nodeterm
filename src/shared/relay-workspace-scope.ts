import type { Workspace } from './types'

/**
 * Narrow a Workspace to the single project a relay hosting session shares with its peer.
 *
 * Returns a Workspace containing ONLY the project whose `id === projectId`, with
 * `activeProjectId` pointing at it. If no project matches (it was deleted/closed since
 * hosting started), the projects list is empty and `activeProjectId` is `''`. Every other
 * top-level field is carried through untouched. This only ever NARROWS — it can never expose
 * a project the source workspace did not already contain. Pure (does not mutate the input).
 */
export function scopeWorkspaceToProject(ws: Workspace, projectId: string): Workspace {
  const projects = ws.projects.filter((p) => p.id === projectId)
  return { ...ws, projects, activeProjectId: projects.length > 0 ? projectId : '' }
}
