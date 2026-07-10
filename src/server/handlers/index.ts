import type { Settings } from '../../shared/types'
import type { ServerPlatform } from '../platform-server'
import { GitService } from '../../core/git-service'
import { generateCommitMessage } from '../../core/commit-message'
import { registerFsHandlers } from './fs'
import { IPC } from '../../shared/ipc'

/** Register the Phase-3a handler surface (fs + git + commit) on the server platform.
 *  git.setActiveRemote is a local-only no-op here: it exists to arm SSH-project remote
 *  routing on desktop, which the server edition does not have (terminals are local). */
export function registerCoreHandlers(
  platform: ServerPlatform,
  deps: { getSettings: () => Settings }
): { gitService: GitService } {
  registerFsHandlers(platform)

  const gitService = new GitService()
  // registers all git:* channels via the global core platform().handle
  gitService.registerIpc()

  // Desktop: ipcMain.handle(IPC.commitGenerate, (_e, cwd) => generateCommitMessage(cwd, settingsStore.get()))
  platform.handle(IPC.commitGenerate, (cwd: string) =>
    generateCommitMessage(cwd, deps.getSettings())
  )
  // Local server has no SSH projects; keep git running against the local remote.
  platform.handle(IPC.gitSetActiveRemote, () => null)

  return { gitService }
}
