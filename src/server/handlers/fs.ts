import type { ServerPlatform } from '../platform-server'
import * as fsOps from '../../core/fs-ops'
import { IPC } from '../../shared/ipc'

/** Register the fs.* + files.quickOpen RPC surface. The desktop registers these inline in
 *  src/main/index.ts; the logic is already pure in src/core/fs-ops.ts, so the server just
 *  wraps it. Threat model: an authenticated user already has a shell, so server-local file
 *  read/write adds no new exposure. */
export function registerFsHandlers(platform: ServerPlatform): void {
  platform.handle(IPC.fsList, (dirPath: string) => fsOps.listDir(dirPath))
  platform.handle(IPC.fsRead, (filePath: string) => fsOps.readText(filePath))
  platform.handle(IPC.fsReadBinary, (filePath: string) => fsOps.readBinary(filePath))
  platform.handle(IPC.fsWrite, (filePath: string, content: string) => fsOps.writeText(filePath, content))
  platform.handle(IPC.filesQuickOpen, (cwd: string) => fsOps.listQuickOpenFiles(cwd))
}
