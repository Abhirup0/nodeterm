import { promises as fs } from 'fs'
import path from 'path'
import { app, ipcMain } from 'electron'
import { IPC } from '../shared/ipc'
import { EMPTY_WORKSPACE, type Workspace } from '../shared/types'

/**
 * Stores the workspace JSON in the user's userData directory.
 * MVP keeps a single workspace file: workspace.json
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
      const parsed = JSON.parse(raw) as Workspace
      if (parsed?.version === 1 && Array.isArray(parsed.nodes)) return parsed
      return EMPTY_WORKSPACE
    } catch {
      // Missing or corrupt file -> return an empty workspace.
      return EMPTY_WORKSPACE
    }
  }

  async save(workspace: Workspace): Promise<void> {
    await fs.writeFile(this.filePath, JSON.stringify(workspace, null, 2), 'utf-8')
  }
}
