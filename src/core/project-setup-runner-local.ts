import { execFile, spawn } from 'child_process'
import path from 'path'
import { findInPathString, shellPathNow } from './exec-path'
import type { ProjectSetupRunner, ProjectSetupTarget } from './project-setup-service'
import { SETUP_OUTPUT_CAP, SETUP_TIMEOUT_MS, createSetupOutputStream } from './setup-output-stream'
import type { WorktreeListResult } from '../shared/worktree'

// The cap/timeout/debounce/truncation rules moved to `setup-output-stream.ts` when the SSH runner
// arrived — both runners MUST report the same way (see that file). Re-exported here because this
// module was their original home and callers/tests import them from it.
export { SETUP_OUTPUT_CAP, SETUP_TIMEOUT_MS }

/** Resolve a configured shell to an absolute path via the cached login-shell PATH (exec-path.ts) —
 *  a GUI process's inherited PATH misses Homebrew/nvm/etc, the same problem commit-message.ts's
 *  `resolveBinary` solves for commit agents. An explicit path (contains a separator) is used as-is;
 *  an unresolvable bare name is handed to `spawn` unchanged so ITS own PATH search gets a chance
 *  (and a genuine ENOENT still surfaces cleanly through the runner's `error` handling below). */
function resolveShellBin(shell: string): string {
  if (shell.includes('/') || shell.includes('\\')) return shell
  return findInPathString(shell, shellPathNow() ?? process.env.PATH) ?? shell
}

/**
 * The local half of `ProjectSetupRunner` (Task 1's `project-setup-service.ts` injects it as
 * `runLocal`): `spawn(shell, ['-lc', script], …)` with the commit-message.ts spawn discipline —
 * capped+debounced output, a hard timeout, an abort-signal kill, and a Promise that NEVER rejects
 * (a spawn failure resolves `{exitCode: 127}` with the error text as a chunk, exactly like a
 * failed script run — the service layer has one failure shape to handle, not two).
 */
export function makeLocalSetupRunner(opts?: { shell?: string; timeoutMs?: number }): ProjectSetupRunner {
  const shell = opts?.shell?.trim() || 'sh'
  const timeoutMs = opts?.timeoutMs ?? SETUP_TIMEOUT_MS

  return ({ script, cwd, env, onChunk, signal }) =>
    new Promise((resolve) => {
      // Already aborted before we ever spawned (a cancel raced the async gate above this call) —
      // nothing to kill, and starting a process now would leak one nobody is waiting for.
      if (signal.aborted) {
        resolve({ exitCode: 143 })
        return
      }

      const { append, flush } = createSetupOutputStream(onChunk)

      const isWin = process.platform === 'win32'
      const shellBin = resolveShellBin(shell)
      const child = spawn(shellBin, ['-lc', script], {
        cwd,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        // POSIX: a new session/process-group leader (setsid), so `killTree` below can SIGKILL the
        // whole group — not just the shell. A script's own children (`npm install` spawning its own
        // tree, a backgrounded `sleep`, `yes | …`) inherit our stdout/stderr pipes; killing only the
        // immediate shell leaves them running and holding those pipes open, so `close` never fires
        // and cancel/timeout silently do nothing until the orphan exits on its own. Verified: killing
        // only the direct child hangs `close` for the ORPHAN's remaining lifetime, not ours.
        detached: !isWin
      })

      // Kill the shell AND every process it spawned (see the `detached` comment above) — never just
      // the shell itself. POSIX: SIGKILL the whole process group via the negative pid. Windows has no
      // such group-kill; `taskkill /t` walks the same parent-child tree `detached` would have no
      // effect on anyway, so Windows never opts into `detached`.
      const killTree = (): void => {
        if (!child.pid) return
        if (isWin) {
          execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {
            // Best-effort: ENOENT/'not found' just means it already exited.
          })
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          } catch {
            // The group is already gone (process exited between our check and this call) — nothing
            // left to kill.
          }
        }
      }

      const timeoutTimer = setTimeout(killTree, timeoutMs)
      timeoutTimer.unref?.()
      const onAbort = (): void => killTree()
      signal.addEventListener('abort', onAbort)

      const finish = (exitCode: number): void => {
        clearTimeout(timeoutTimer)
        signal.removeEventListener('abort', onAbort)
        flush() // final flush — whatever the debounce timer hadn't fired yet
        resolve({ exitCode })
      }

      child.stdout?.on('data', (d: Buffer) => append(d.toString('utf-8')))
      child.stderr?.on('data', (d: Buffer) => append(d.toString('utf-8')))
      // Never reject: a spawn failure (bad shell path, EACCES, …) is reported the same way a
      // failing SCRIPT is — a chunk plus a non-zero exit — so the service layer has one shape to
      // handle either way.
      child.on('error', (e) => {
        append(`${(e as Error).message}\n`)
        finish(127)
      })
      child.on('close', (code) => finish(code ?? 1))
    })
}

/** Minimal shape `resolveProjectSetupTarget` needs from the workspace index — see
 *  `WorkspaceStore.projectTargetInfo`. */
export interface ProjectSetupTargetInfo {
  cwd?: string
  ssh?: ProjectSetupTarget['ssh']
  name: string
}

/**
 * Turns a renderer's `(projectId, worktreePath?)` into a fully-trusted `ProjectSetupTarget`, or
 * `null` when it cannot — the CARRIED Task 1 review finding: `rootPath`/`projectName`/`ssh` are
 * NEVER taken from the renderer (a hostile/compromised renderer could otherwise name any path on
 * disk, or forge an `ssh` target pointing somewhere it does not own). `info` comes straight from
 * `WorkspaceStore.projectTargetInfo(projectId)` — the machine-local index, not attacker-controlled
 * `project.json` content.
 *
 * `worktreePath`, when given, must be an absolute path that is either the project's own rootPath OR
 * one of ITS ACTUAL git worktrees (`listWorktrees`, e.g. `GitService.worktreeList` bound to the
 * caller's instance) — never a plain "is it a subdirectory of rootPath" check: the default worktree
 * layout (`../${repoName}.worktrees/${branch}`, see shared/worktree.ts) is a SIBLING of the repo,
 * not nested under it, so containment would reject the common case. Worktrees are local-only (the
 * SDD plan's ruling): an ssh target with a worktreePath is refused outright rather than silently
 * dropping the worktree half.
 *
 * Exported (not file-private) so it is unit-testable without Electron/git — callers pass a fake
 * `listWorktrees` in tests, and the real `GitService#worktreeList` in main/server wiring.
 */
export async function resolveProjectSetupTarget(
  projectId: string,
  worktreePath: string | undefined,
  info: ProjectSetupTargetInfo | null,
  listWorktrees: (repoPath: string) => Promise<WorktreeListResult>
): Promise<ProjectSetupTarget | null> {
  if (!info) return null

  if (info.ssh) {
    // Worktrees are local-only (git runs against a local filesystem) — a worktreePath alongside an
    // ssh target is either a stale renderer state or hostile input. Refuse rather than guess which.
    if (worktreePath !== undefined) return null
    return { projectId, projectName: info.name, rootPath: info.ssh.remoteCwd, ssh: info.ssh }
  }

  // No local folder and no ssh target — an inline/cwd-less canvas has nothing to run against.
  if (!info.cwd) return null

  const target: ProjectSetupTarget = { projectId, projectName: info.name, rootPath: info.cwd }
  if (worktreePath === undefined) return target

  if (!path.isAbsolute(worktreePath)) return null
  const resolvedRoot = path.resolve(info.cwd)
  const resolvedWt = path.resolve(worktreePath)
  if (resolvedWt !== resolvedRoot) {
    let listed: WorktreeListResult
    try {
      listed = await listWorktrees(info.cwd)
    } catch {
      return null
    }
    if (!listed.ok) return null
    const known = listed.entries.some((e) => path.resolve(e.path) === resolvedWt)
    if (!known) return null
  }
  target.worktreePath = resolvedWt
  return target
}
