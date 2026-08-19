import { IPC } from '../shared/ipc'
import type { ProjectSetupConsentAnswer, ProjectSetupKind, ProjectSetupRunResult } from '../shared/project-settings'
import type { CorePlatform } from './platform'
import type { ProjectSetupTarget } from './project-setup-service'

/**
 * RPC surface for the setup/archive runner, registered once for every shell (Electron main + Server
 * Edition) through CorePlatform — the github/board-log handlers pattern.
 *
 * v1 keeps `projectSetupSubscribe`/`Unsubscribe` as accepted no-ops: unlike the log ring, a setup
 * run produces nothing until someone launches one, so there is no idle stream to gate and the
 * `projectSetupEvent` push is registered unconditionally. The channels exist so the renderer's
 * lifecycle (and a later ref-counted gate) needs no protocol change.
 *
 * Everything crossing this seam is renderer/client input, so the target is shape-checked here
 * rather than trusted — the service's own gate protects the dangerous half, but a malformed target
 * must answer a result, not throw an IPC error.
 */
export interface ProjectSetupHandlerService {
  run(target: ProjectSetupTarget, kind: ProjectSetupKind): Promise<ProjectSetupRunResult>
  cancel(runKey: string): boolean
  submitConsent(requestId: string, answer: ProjectSetupConsentAnswer): void
}

const isKind = (v: unknown): v is ProjectSetupKind => v === 'setup' || v === 'archive'

function sanitizeTarget(v: unknown): ProjectSetupTarget | null {
  if (typeof v !== 'object' || v === null) return null
  const t = v as Record<string, unknown>
  if (typeof t.projectId !== 'string' || !t.projectId) return null
  if (typeof t.projectName !== 'string') return null
  if (typeof t.rootPath !== 'string' || !t.rootPath) return null
  const out: ProjectSetupTarget = {
    projectId: t.projectId,
    projectName: t.projectName,
    rootPath: t.rootPath
  }
  if (typeof t.worktreePath === 'string' && t.worktreePath) out.worktreePath = t.worktreePath
  if (t.ssh !== undefined) {
    // A malformed `ssh` is REJECTED, never stripped: dropping the field would silently downgrade a
    // remote run into a local one, executing the remote project's script on this machine — and
    // against the wrong (local) trust key.
    const ssh = typeof t.ssh === 'object' && t.ssh !== null ? (t.ssh as Record<string, unknown>) : null
    if (!ssh) return null
    const server =
      typeof ssh.server === 'object' && ssh.server !== null ? (ssh.server as Record<string, unknown>) : null
    if (!server) return null
    if (typeof server.host !== 'string' || !server.host) return null
    if (typeof server.user !== 'string' || !server.user) return null
    if (server.port !== undefined && typeof server.port !== 'number') return null
    if (server.identityFile !== undefined && typeof server.identityFile !== 'string') return null
    if (typeof ssh.remoteCwd !== 'string' || !ssh.remoteCwd) return null
    out.ssh = {
      server: {
        host: server.host,
        user: server.user,
        ...(typeof server.port === 'number' ? { port: server.port } : {}),
        ...(typeof server.identityFile === 'string' ? { identityFile: server.identityFile } : {})
      },
      remoteCwd: ssh.remoteCwd
    }
  }
  return out
}

export function registerProjectSetupHandlers(
  platform: CorePlatform,
  service: ProjectSetupHandlerService
): void {
  platform.handle(IPC.projectSetupRun, async (target: unknown, kind: unknown): Promise<ProjectSetupRunResult> => {
    const t = sanitizeTarget(target)
    if (!t || !isKind(kind)) return { status: 'skipped', reason: 'unavailable' }
    return service.run(t, kind)
  })
  platform.handle(IPC.projectSetupCancel, (runKey: unknown) =>
    typeof runKey === 'string' ? service.cancel(runKey) : false)
  platform.on(IPC.projectSetupConsentSubmit, (requestId: unknown, answer: unknown) => {
    if (typeof requestId !== 'string') return
    if (answer !== 'approve' && answer !== 'skip') return
    service.submitConsent(requestId, answer)
  })
  platform.on(IPC.projectSetupSubscribe, () => {})
  platform.on(IPC.projectSetupUnsubscribe, () => {})
}
