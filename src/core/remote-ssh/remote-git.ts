// Run git over an SSH project's ControlMaster. The pure builder composes `cd <cwd> && git <args>`
// (cwd tilde-expands via quoteRemotePath; every arg posixQuote'd so a ref/branch/message can't
// inject into the remote shell). runRemoteGit returns the SAME { ok, out, err } shape as the local
// git() helper so callers are transport-agnostic. A module-level resolver registry lets both
// git-service.ts and commit-message.ts route the same way without threading a ref through every op.
import { execFile, execFileSync } from 'child_process'
import { promisify } from 'util'
import { childArgs } from './control-master'
import { posixQuote, quoteRemotePath, type SshConnection } from '../../shared/ssh'

const run = promisify(execFile)

export interface GitRemoteRef {
  conn: SshConnection
  controlPath: string
}

export function remoteGitArgs(conn: SshConnection, controlPath: string, cwd: string, args: string[]): string[] {
  const remote = `cd ${quoteRemotePath(cwd)} && git ${args.map(posixQuote).join(' ')}`
  return childArgs(conn, controlPath, remote)
}

let sshPath: string | null | undefined
function findSsh(): string | null {
  if (sshPath !== undefined) return sshPath
  // GUI apps don't inherit the shell PATH, so probe a login shell first (mirrors
  // commit-message.ts). Kept self-contained — importing ssh-project.ts would pull in electron and
  // break this module's pure vitest tests.
  try {
    const out = execFileSync('/usr/bin/env', ['sh', '-lc', 'command -v ssh'], {
      encoding: 'utf-8'
    }).trim()
    if (out) {
      execFileSync(out, ['-V'], { stdio: 'ignore' })
      sshPath = out
      return out
    }
  } catch {
    /* fall back to the hardcoded paths */
  }
  for (const p of ['/usr/bin/ssh', '/usr/local/bin/ssh', '/opt/homebrew/bin/ssh']) {
    try {
      execFileSync(p, ['-V'], { stdio: 'ignore' })
      sshPath = p
      return p
    } catch {
      /* try next */
    }
  }
  sshPath = null
  return null
}

/** Run a git command on the remote over the master. Returns the same shape as the local git() helper. */
export async function runRemoteGit(
  ref: GitRemoteRef,
  cwd: string,
  args: string[],
  maxBuffer: number
): Promise<{ ok: boolean; out: string; err: string }> {
  const ssh = findSsh()
  if (!ssh) return { ok: false, out: '', err: 'ssh not found' }
  try {
    const { stdout } = await run(ssh, remoteGitArgs(ref.conn, ref.controlPath, cwd, args), { maxBuffer })
    return { ok: true, out: stdout.replace(/\n$/, ''), err: '' }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: (err.stdout ?? '').trim(), err: (err.stderr || err.message || '').trim() }
  }
}

let resolver: ((cwd: string) => GitRemoteRef | undefined) | null = null
export function setGitRemoteResolver(fn: ((cwd: string) => GitRemoteRef | undefined) | null): void {
  resolver = fn
}
export function resolveGitRemote(cwd: string): GitRemoteRef | undefined {
  return resolver ? resolver(cwd) : undefined
}
