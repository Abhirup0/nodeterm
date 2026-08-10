// RPC surface for session memory. Registered by BOTH shells (src/main and src/server) exactly as
// the usage service is: core owns the reading and the parsing, the shell injects the ControlMaster.
//
// The one decision made here is WHICH MACHINE answers. Everything else is delegated:
// `collectSessionMemory` for this host, `fetchRemoteSessionMemory` for an SSH project's host.

import { IPC } from '../shared/ipc'
import { platform } from './platform'
import type { MemInfo, SessionMemoryQuery, SessionMemoryReport } from '../shared/types'
import { collectSessionMemory, readMemInfo } from './session-memory'
import { fetchRemoteSessionMemory, type RemoteSessionMemoryRunner } from './session-memory-remote'

export interface SessionMemoryServiceOptions {
  /** Lazy tmux resolver (PtyManager resolves after init; null = tmux unavailable). */
  tmuxBin: () => string | null
  /** Host RAM reader, injectable for tests. Defaults to the real `/proc/meminfo` read. */
  readMem?: () => MemInfo | null
  /** Absent ⇒ SSH scopes answer `ok:false` — see the handler. */
  remote?: {
    run: RemoteSessionMemoryRunner
    isRemoteProject: (projectId: string) => boolean
  }
}

const EMPTY = (mem: MemInfo | null): SessionMemoryReport => ({ ok: false, rows: [], mem })

export function startSessionMemoryService(opts: SessionMemoryServiceOptions): { dispose(): void } {
  /**
   * Two independent sources say "this scope is remote", and EITHER is enough:
   *  - the renderer's own `remote` flag (it already knows from `usageScope` which project is an
   *    SSH one), and
   *  - the shell's project manager.
   * They are OR-ed, not AND-ed, on purpose. A manager that has not (yet) registered a project as
   * connected — reconnecting, just dropped — would otherwise turn a remote query into a LOCAL
   * sweep, and the panel would label this machine's sessions as the host's. A claim of remoteness
   * is trusted; only its answer can fail.
   */
  const isRemote = (q: SessionMemoryQuery): boolean =>
    q.remote === true || (!!q.projectId && !!opts.remote?.isRemoteProject(q.projectId))

  platform().handle(
    IPC.sessionMemory,
    async (q: SessionMemoryQuery = {}): Promise<SessionMemoryReport> => {
      if (isRemote(q)) {
        // No ControlMaster injected (Server Edition), or nothing to run against: answering with
        // the LOCAL machine's sessions would attribute one host's memory to another. Refuse — and
        // with a null `mem` too, since even the RAM number would describe the wrong machine.
        if (!opts.remote || !q.projectId) return EMPTY(null)
        return fetchRemoteSessionMemory(q.projectId, opts.remote.run)
      }
      return collectSessionMemory({ tmuxBin: opts.tmuxBin, readMem: opts.readMem })
    }
  )

  platform().handle(
    IPC.sessionMemoryHost,
    async (q: SessionMemoryQuery = {}): Promise<MemInfo | null> => {
      if (!isRemote(q)) return (opts.readMem ?? readMemInfo)()
      if (!opts.remote || !q.projectId) return null
      // One round trip serves both numbers; the pill uses only `mem`.
      return (await fetchRemoteSessionMemory(q.projectId, opts.remote.run)).mem
    }
  )

  // Nothing to tear down: both handlers are pull-only, with no timer and no cache. `dispose` exists
  // so a shell can treat this like the other services it starts.
  return { dispose: (): void => {} }
}
