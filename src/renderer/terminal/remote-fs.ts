// Remote filesystem API (renderer).
//
// `remoteFs(connectionId)` returns an object satisfying the same `FsApi` contract as
// `window.nodeTerminal.fs`, but scoped to a remote connection: every call proxies onto the HOST's
// filesystem over the E2EE relay (renderer → `remoteClient.fs*` IPC → client-service `fs.*` RPC →
// host-service `fs.*` handler → shared fs-ops). Because the shape matches the local `FsApi`
// exactly, nodes (Editor/Diff/Explorer) can pick `remoteFs(connectionId)` instead of the local fs
// when they are rendered inside a remote session, with behaviour identical to local.

import type { FsApi } from '@shared/types'

/** Build an `FsApi` bound to a remote connection (proxies to the host's filesystem). */
export function remoteFs(connectionId: string): FsApi {
  const client = window.nodeTerminal.remoteClient
  return {
    list: (dirPath) => client.fsList(connectionId, dirPath),
    read: (filePath) => client.fsRead(connectionId, filePath),
    readBinary: (filePath) => client.fsReadBinary(connectionId, filePath),
    write: (filePath, content) => client.fsWrite(connectionId, filePath, content)
  }
}
