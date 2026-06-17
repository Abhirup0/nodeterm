import { promises as fs } from 'fs'
import path from 'path'
import { app, ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import {
  DEFAULT_PROJECT_ID,
  EMPTY_WORKSPACE,
  type Workspace,
  type WorkspaceV1
} from '../shared/types'

/**
 * Stores the workspace JSON in the user's userData directory.
 * A single file (workspace.json) holds all projects.
 */
export class WorkspaceStore {
  private get filePath(): string {
    return path.join(app.getPath('userData'), 'workspace.json')
  }

  registerIpc(): void {
    ipcMain.handle(IPC.workspaceLoad, () => this.load())
    ipcMain.handle(IPC.workspaceSave, (_event, workspace: Workspace) => this.save(workspace))
  }

  async load(): Promise<Workspace> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      return migrate(JSON.parse(raw))
    } catch {
      // Missing or corrupt file -> return an empty workspace.
      return EMPTY_WORKSPACE
    }
  }

  async save(workspace: Workspace): Promise<void> {
    // Atomic write: a crash/kill mid-write to the real file would truncate it, and a
    // corrupt workspace.json silently loads as empty (total layout loss). Write to a
    // temp file then rename (atomic on the same filesystem).
    const tmp = `${this.filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(workspace, null, 2), 'utf-8')
    await fs.rename(tmp, this.filePath)
  }
}

/** Normalize any on-disk shape (v1 single canvas, v2 projects) into a valid v2 workspace. */
function migrate(parsed: unknown): Workspace {
  const ws = parsed as Partial<Workspace> & Partial<WorkspaceV1>

  // v2: keep as-is, including an empty project list (→ welcome screen).
  if (ws?.version === 2 && Array.isArray(ws.projects)) {
    const active = ws.projects.some((p) => p.id === ws.activeProjectId)
      ? (ws.activeProjectId as string)
      : (ws.projects[0]?.id ?? '')
    return { version: 2, activeProjectId: active, projects: ws.projects }
  }

  // v1: a single canvas -> wrap it in one default project.
  if (ws?.version === 1 && Array.isArray(ws.nodes)) {
    return {
      version: 2,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects: [
        {
          id: DEFAULT_PROJECT_ID,
          name: 'Project 1',
          color: '#7aa2f7',
          viewport: ws.viewport ?? { x: 0, y: 0, zoom: 1 },
          nodes: ws.nodes
        }
      ]
    }
  }

  return EMPTY_WORKSPACE
}
