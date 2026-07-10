import path from 'path'
import type { Project } from '../shared/types'
import type { RemoteWorkspaceIO } from '../core/workspace-store'
import { PROJECT_DIR, PROJECT_FILE } from '../core/workspace-files'
import type { SshFs, SshFsRef } from './ssh-fs'

/** Resolves an SSH project's live control master; null while disconnected. */
type RefResolver = (projectId: string) => SshFsRef | null

/**
 * Remote .nodeterm IO over the project's existing ControlMaster. Fail-open: while the
 * project is disconnected every call is a quiet no-op (read null / write false) — the
 * cache in workspace.json keeps the project usable offline. Writes are throttled per
 * project (the renderer already debounces at 800 ms; a remote round-trip per keystroke
 * burst is still too chatty — spec says ~5 s).
 */
export function makeRemoteWorkspaceIO(resolveRef: RefResolver, sshFs: SshFs): RemoteWorkspaceIO {
  const lastWrite = new Map<string, number>()
  const pending = new Map<string, ReturnType<typeof setTimeout>>()
  const WRITE_THROTTLE_MS = 5000

  const remotePath = (ssh: NonNullable<Project['ssh']>): string =>
    path.posix.join(ssh.remoteCwd, PROJECT_DIR, PROJECT_FILE)

  return {
    async read(projectId, ssh) {
      const ref = resolveRef(projectId)
      if (!ref) return null
      const text = await sshFs.readText(ref, remotePath(ssh))
      return text || null
    },
    async write(projectId, ssh, content) {
      const ref = resolveRef(projectId)
      if (!ref) return false
      const run = async () => {
        lastWrite.set(projectId, Date.now())
        await sshFs.writeText(ref, remotePath(ssh), content)
      }
      const since = Date.now() - (lastWrite.get(projectId) ?? 0)
      if (since >= WRITE_THROTTLE_MS) {
        // Cancel any pending trailing write so a stale older payload can't fire AFTER this newer
        // one and clobber the final state (final-state-wins).
        clearTimeout(pending.get(projectId))
        pending.delete(projectId)
        await run()
      } else {
        clearTimeout(pending.get(projectId))
        pending.set(projectId, setTimeout(() => void run(), WRITE_THROTTLE_MS - since))
      }
      return true
    }
  }
}
