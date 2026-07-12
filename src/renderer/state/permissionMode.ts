import { resolvePermissionMode, type AgentPermissionMode } from '@shared/agents/config'
import { useProjects } from './projects'
import { useSettings } from './settings'

/**
 * The permission mode a session launched right now should start in: the active project's
 * override, else the global setting.
 *
 * Lives in its own module rather than in workspace.ts because projects.ts imports workspace.ts
 * (createProject) — importing the projects store from workspace.ts would close that cycle.
 */
export function activePermissionMode(): AgentPermissionMode {
  const { settings } = useSettings.getState()
  const { getProject, activeProjectId } = useProjects.getState()
  return resolvePermissionMode(getProject(activeProjectId), settings)
}
