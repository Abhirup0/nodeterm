import { IPC } from '../shared/ipc'
import type { ProjectSetupConsentAnswer, ProjectSetupKind, ProjectSetupRunResult } from '../shared/project-settings'
import type { WorktreeListResult } from '../shared/worktree'
import type { CorePlatform } from './platform'
import type { ProjectConsumerFamily, ProjectSetupTarget } from './project-setup-service'
import { resolveProjectSetupTarget, type ProjectSetupTargetInfo } from './project-setup-runner-local'

/**
 * RPC surface for the setup/archive runner, registered once for every shell (Electron main + Server
 * Edition) through CorePlatform — the github/board-log handlers pattern.
 *
 * v1 keeps `projectSetupSubscribe`/`Unsubscribe` as accepted no-ops: unlike the log ring, a setup
 * run produces nothing until someone launches one, so there is no idle stream to gate and the
 * `projectSetupEvent` push is registered unconditionally. The channels exist so the renderer's
 * lifecycle (and a later ref-counted gate) needs no protocol change.
 *
 * The wire's `run` carries ONLY `(projectId, kind, worktreePath?)` — the same three things
 * `ProjectSetupApi.run` exposes to the renderer. `rootPath`/`projectName`/`ssh` are never on the
 * wire at all: this registrar derives them itself, from `deps.projectTargetInfo` (this shell's own
 * workspace index, never the renderer) by `projectId`, and independently re-validates
 * `worktreePath` against `deps.worktreeList`'s answer for that project (`resolveProjectSetupTarget`,
 * project-setup-runner-local.ts) — a hostile/compromised renderer cannot name an arbitrary path or
 * forge an `ssh` target this way. `cancel`/`consentSubmit` carry no path-shaped data and are
 * shape-checked in place, same as before.
 */
export interface ProjectSetupHandlerService {
  run(target: ProjectSetupTarget, kind: ProjectSetupKind): Promise<ProjectSetupRunResult>
  cancel(runKey: string): boolean
  submitConsent(requestId: string, answer: ProjectSetupConsentAnswer): void
  /** The launch-settings gate (`ProjectSetupService.ensureFamilyTrusted`). OPTIONAL so a service
   *  built against the run-only surface still registers; the channel is registered either way and
   *  simply answers `false` — fail closed, never a missing-handler rejection a caller has to
   *  special-case. */
  ensureFamilyTrusted?(target: ProjectSetupTarget, family: ProjectConsumerFamily): Promise<boolean>
}

/** What `registerProjectSetupHandlers` needs from its shell to resolve a trusted target — the
 *  Task 1 review finding, closed centrally here so main/server share the ONE implementation instead
 *  of each re-deriving it. */
export interface ProjectSetupHandlerDeps {
  /** This shell's own workspace index lookup (e.g. `WorkspaceStore.projectTargetInfo`). */
  projectTargetInfo(projectId: string): ProjectSetupTargetInfo | null
  /** `git worktree list` for a repo root (e.g. `GitService#worktreeList` bound to the caller). */
  worktreeList(repoPath: string): Promise<WorktreeListResult>
}

const isKind = (v: unknown): v is ProjectSetupKind => v === 'setup' || v === 'archive'

/**
 * "Make sure this project's `<family>` is trusted", by project id alone — the derivation shared by
 * the `projectSetupRequestTrust` channel below and by the SPAWN's own reader
 * (`makeProjectSpawnOverrides`, wired in main/server). Same trust boundary as `run`: rootPath /
 * projectName / ssh come from THIS process's workspace index, never from a caller.
 *
 * No worktree argument at all — trust is keyed to the project ROOT (a worktree inherits the root's
 * approval), so there is no path-shaped input to validate. Answers `false` when the project cannot
 * be resolved or the service has no gate; never throws.
 */
export function makeProjectTrustRequester(
  service: ProjectSetupHandlerService,
  deps: ProjectSetupHandlerDeps
): (projectId: string, family: ProjectConsumerFamily) => Promise<boolean> {
  return async (projectId, family) => {
    const ask = service.ensureFamilyTrusted?.bind(service)
    if (!ask) return false
    const info = deps.projectTargetInfo(projectId)
    const target = await resolveProjectSetupTarget(projectId, undefined, info, deps.worktreeList)
    if (!target) return false
    return ask(target, family)
  }
}

export function registerProjectSetupHandlers(
  platform: CorePlatform,
  service: ProjectSetupHandlerService,
  deps: ProjectSetupHandlerDeps
): void {
  platform.handle(
    IPC.projectSetupRun,
    async (projectId: unknown, kind: unknown, worktreePath?: unknown): Promise<ProjectSetupRunResult> => {
      if (typeof projectId !== 'string' || !projectId || !isKind(kind)) {
        return { status: 'skipped', reason: 'unavailable' }
      }
      if (worktreePath !== undefined && typeof worktreePath !== 'string') {
        return { status: 'skipped', reason: 'unavailable' }
      }
      const info = deps.projectTargetInfo(projectId)
      const target = await resolveProjectSetupTarget(projectId, worktreePath, info, deps.worktreeList)
      if (!target) return { status: 'skipped', reason: 'unavailable' }
      return service.run(target, kind)
    }
  )
  const requestTrust = makeProjectTrustRequester(service, deps)
  platform.handle(
    IPC.projectSetupRequestTrust,
    async (projectId: unknown, family: unknown): Promise<boolean> => {
      // `setup` is NOT accepted: that family is gated inside `run` itself, and admitting it here
      // would hand a caller a run-less way to raise (and then answer) the host's setup dialog.
      if (typeof projectId !== 'string' || !projectId) return false
      if (family !== 'agents' && family !== 'shell') return false
      return requestTrust(projectId, family)
    }
  )
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
