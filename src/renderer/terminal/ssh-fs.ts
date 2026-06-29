// SSH-project filesystem API (renderer). `sshFs(projectId)` satisfies the same FsApi contract as
// window.nodeTerminal.fs / remoteFs(connectionId), but proxies onto the SSH project's remote
// filesystem over the ControlMaster (renderer → sshFs:* IPC → main ssh-fs over the master).
import type { FsApi } from '@shared/types'

export function sshFs(projectId: string): FsApi {
  const api = window.nodeTerminal.sshFs
  return {
    list: (path) => api.list(projectId, path),
    read: (path) => api.read(projectId, path),
    readBinary: (path) => api.readBinary(projectId, path),
    write: (path, content) => api.write(projectId, path, content)
  }
}
