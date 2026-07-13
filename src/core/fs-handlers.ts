import type { CorePlatform } from './platform'
import * as fsOps from './fs-ops'
import { IPC } from '../shared/ipc'

/** The fs.* + files.quickOpen RPC surface, registered ONCE for every shell (Electron main, the
 *  Server Edition, and — through the Electron platform's handler table — a relay peer). The logic
 *  is already pure in core/fs-ops.ts; this is only the registration.
 *
 *  It lives here, and not in either shell, so the two can never drift: the desktop used to register
 *  these on raw `ipcMain`, which made them unreachable for a peer (a peer has no webContents).
 *  Threat model unchanged: whoever can reach these already has a terminal on this machine. */
export function registerFsHandlers(platform: CorePlatform): void {
  platform.handle(IPC.fsList, (dirPath: string) => fsOps.listDir(dirPath))
  platform.handle(IPC.fsRead, (filePath: string) => fsOps.readText(filePath))
  platform.handle(IPC.fsReadBinary, (filePath: string) => fsOps.readBinary(filePath))
  platform.handle(IPC.fsWrite, (filePath: string, content: string) =>
    fsOps.writeText(filePath, content)
  )
  platform.handle(IPC.fsMkdir, (dirPath: string) => fsOps.makeDir(dirPath))
  platform.handle(IPC.fsExists, (p: string) => fsOps.pathExists(p))
  platform.handle(IPC.filesQuickOpen, (cwd: string) => fsOps.listQuickOpenFiles(cwd))
}
