import { execFile, spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { IPC } from '../shared/ipc'
import type { GitFileChange, GitResult, GitStatus } from '../shared/types'
import { loadGitHistoryFromExecutor } from '../shared/git-history'
import * as worktreeOps from '../shared/worktree-ops'
import type { GitHistoryOptions, GitHistoryResult } from '../shared/git-history'
import { resolveGitRemote, runRemoteGit } from './remote-ssh/remote-git'
import { platform } from './platform'
import {
  isValidCloneUrl,
  expandCloneUrl,
  deriveRepoDirName,
  parseCloneProgress,
  stripAnsiCodes
} from '../shared/clone-url'

const run = promisify(execFile)

function findBin(names: string[]): string | null {
  for (const c of names) {
    try {
      if (fs.existsSync(c)) return c
    } catch {
      // ignore
    }
  }
  return null
}

const GH_PATH = findBin(['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'])

// GUI apps on macOS don't inherit the shell PATH, so a git credential helper installed by
// Homebrew (e.g. `gh auth git-credential`, or osxkeychain shims) wouldn't be found by our
// `git` subprocess — making push/pull fail even when the user is authed. Prepend the common
// bin dirs. GIT_TERMINAL_PROMPT=0 makes auth failures error out fast instead of hanging on a
// username prompt (there's no TTY here).
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin${process.env.PATH ? `:${process.env.PATH}` : ''}`,
  GIT_TERMINAL_PROMPT: '0'
}

// Single-flight registry for the one clone the app runs at a time. Module-scoped so a
// macOS window re-creation can't orphan it.
type ActiveClone = {
  child: import('child_process').ChildProcess | null
  clonePath: string
  aborted: boolean
}
let activeClone: ActiveClone | null = null

// `gh auth status` is a network-touching CLI call but auth state changes rarely, so cache
// it briefly — otherwise every status refresh pays a process spawn (and possible round-trip).
const GH_AUTH_TTL_MS = 60_000
let ghAuthedCache: { value: boolean; at: number } | null = null

async function ghAuthed(): Promise<boolean> {
  if (!GH_PATH) return false
  const now = Date.now()
  if (ghAuthedCache && now - ghAuthedCache.at < GH_AUTH_TTL_MS) return ghAuthedCache.value
  let value = false
  try {
    await run(GH_PATH, ['auth', 'status'], { env: GIT_ENV, maxBuffer: 1024 * 1024 })
    value = true
  } catch {
    value = false
  }
  ghAuthedCache = { value, at: now }
  return value
}

interface Exec {
  ok: boolean
  out: string
  err: string
}

async function git(cwd: string, args: string[]): Promise<Exec> {
  // SSH projects route every pure-git op over the project's ControlMaster. runRemoteGit returns
  // the same { ok, out, err } shape, so the rest of GitService is transport-agnostic. Local path
  // (and gh ops) are untouched when no remote owns this cwd.
  const ref = resolveGitRemote(cwd)
  if (ref) {
    const r = await runRemoteGit(ref, cwd, args, 20 * 1024 * 1024)
    return { ok: r.ok, out: r.out, err: r.err }
  }
  try {
    const { stdout } = await run('git', args, { cwd, env: GIT_ENV, maxBuffer: 20 * 1024 * 1024 })
    return { ok: true, out: stdout.replace(/\n$/, ''), err: '' }
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return { ok: false, out: (err.stdout ?? '').trim(), err: (err.stderr || err.message || '').trim() }
  }
}

function parseRepoName(url: string, fallback: string): string {
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1] : fallback
}

/**
 * Reject branch/ref names that could smuggle CLI flags (leading `-`) or are not
 * valid git refs. Defends against argv flag injection on `git switch …`.
 */
function isValidRef(name: string): boolean {
  const n = name.trim()
  if (!n || n.startsWith('-')) return false
  return !/[\s~^:?*[\\]|\.\.|^\/|\/$|@\{/.test(n)
}

/** path -> {added, deleted} from `git diff --numstat` output. */
function parseNumstat(out: string): Map<string, { added: number; deleted: number }> {
  const map = new Map<string, { added: number; deleted: number }>()
  for (const line of out.split('\n').filter(Boolean)) {
    const [a, d, ...rest] = line.split('\t')
    const p = rest.join('\t')
    map.set(p, { added: Number(a) || 0, deleted: Number(d) || 0 })
  }
  return map
}

/**
 * Read the user's stored github.com HTTPS token from git's credential helper
 * (macOS keychain etc.) so we can hand it to `gh` as GH_TOKEN — letting someone
 * who can already push over HTTPS publish a new repo without a separate
 * `gh auth login`. Returns null if no HTTPS credential is stored (e.g. SSH-only).
 * Never logs the token. `git credential fill` reads the query from stdin.
 */
function githubTokenFromGitCredentials(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn('git', ['credential', 'fill'], { cwd: cwd || undefined, env: GIT_ENV })
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.split('\n').find((l) => l.startsWith('password='))
      const token = line ? line.slice('password='.length).trim() : ''
      resolve(token || null)
    })
    child.stdin.write('protocol=https\nhost=github.com\n\n')
    child.stdin.end()
  })
}

/**
 * Per-project git operations using the system `git` (and `gh` for publishing).
 * The repo root is the active project's working directory.
 */
export class GitService {
  registerIpc(): void {
    platform().handle(IPC.gitStatus, (cwd: string) => this.status(cwd))
    platform().handle(IPC.gitInit, (cwd: string) => this.init(cwd))
    platform().handle(IPC.gitClone, (parentDir: string, url: string) => this.clone(parentDir, url))
    platform().handle(IPC.gitCloneAbort, () => this.cloneAbort())
    platform().handle(IPC.gitCloneDefaultParent, () => this.cloneDefaultParent())
    platform().handle(IPC.gitCommit, (cwd: string, message: string) => this.commit(cwd, message))
    platform().handle(IPC.gitPush, (cwd: string) => this.push(cwd))
    platform().handle(IPC.gitPull, (cwd: string) => this.pull(cwd))
    platform().handle(IPC.gitSync, (cwd: string) => this.sync(cwd))
    platform().handle(IPC.gitPublish, (cwd: string, name: string, isPrivate: boolean) =>
      this.publish(cwd, name, isPrivate)
    )
    platform().handle(IPC.gitStage, (cwd: string, paths: string[]) => this.stage(cwd, paths))
    platform().handle(IPC.gitUnstage, (cwd: string, paths: string[]) => this.unstage(cwd, paths))
    platform().handle(IPC.gitStageAll, (cwd: string) => this.stageAll(cwd))
    platform().handle(IPC.gitUnstageAll, (cwd: string) => this.unstageAll(cwd))
    platform().handle(IPC.gitDiff, (cwd: string, p: string, staged: boolean, untracked: boolean) =>
      this.diff(cwd, p, staged, untracked)
    )
    platform().handle(IPC.gitDiscard, (cwd: string, p: string, untracked: boolean) =>
      this.discard(cwd, p, untracked)
    )
    platform().handle(IPC.gitSwitchBranch, (cwd: string, name: string) =>
      this.switchBranch(cwd, name)
    )
    platform().handle(IPC.gitCreateBranch, (cwd: string, name: string) =>
      this.createBranch(cwd, name)
    )
    platform().handle(IPC.gitShowFile, (cwd: string, ref: string, p: string) =>
      this.showFile(cwd, ref, p)
    )
    platform().handle(IPC.gitHistory, (cwd: string, options) => this.history(cwd, options))
    platform().handle(IPC.gitCommitFiles, (cwd: string, oid: string) => this.commitFiles(cwd, oid))
    platform().handle(IPC.gitRemoteCommitUrl, (cwd: string, sha: string) =>
      this.remoteCommitUrl(cwd, sha)
    )
    platform().handle(IPC.gitMerge, (cwd: string, ref: string) => this.merge(cwd, ref))
    platform().handle(IPC.gitRebase, (cwd: string, onto: string) => this.rebase(cwd, onto))
    platform().handle(IPC.gitDeleteBranch, (cwd: string, name: string, force: boolean) =>
      this.deleteBranch(cwd, name, force)
    )
    platform().handle(IPC.gitRenameBranch, (cwd: string, newName: string) =>
      this.renameBranch(cwd, newName)
    )
    platform().handle(IPC.gitFetch, (cwd: string) => this.fetch(cwd))
    platform().handle(IPC.gitForcePush, (cwd: string) => this.forcePush(cwd))
    platform().handle(IPC.gitStashPush, (cwd: string) => this.stashPush(cwd))
    platform().handle(IPC.gitStashPop, (cwd: string) => this.stashPop(cwd))
    platform().handle(IPC.gitRevert, (cwd: string, oid: string) => this.revert(cwd, oid))
    platform().handle(IPC.gitBranchAt, (cwd: string, name: string, oid: string) =>
      this.branchAt(cwd, name, oid)
    )
    platform().handle(IPC.gitCheckoutCommit, (cwd: string, oid: string) =>
      this.checkoutCommit(cwd, oid)
    )
    platform().handle(IPC.gitRepoRoot, (cwd: string) => this.repoRoot(cwd))
    platform().handle(IPC.gitWorktreeList, (repoPath: string) => this.worktreeList(repoPath))
    platform().handle(IPC.gitWorktreeAdd, (repoPath: string, wtPath: string, branch: string, baseRef: string, isNew: boolean) =>
      this.worktreeAdd(repoPath, wtPath, branch, baseRef, isNew)
    )
    platform().handle(IPC.gitWorktreeMerge, (repoPath: string, branch: string, baseRef: string, push?: boolean) =>
      this.worktreeMerge(repoPath, branch, baseRef, push)
    )
    platform().handle(IPC.gitWorktreeRemove, (repoPath: string, wtPath: string, deleteBranch: boolean, pruneOnly?: boolean) =>
      this.worktreeRemove(repoPath, wtPath, deleteBranch, pruneOnly)
    )
  }

  repoRoot(cwd: string) {
    return worktreeOps.repoRoot(git, cwd)
  }
  worktreeList(repoPath: string) {
    // `pathExists` is git's `prunable` flag's fallback for git < 2.36 (see worktree-ops): without
    // it, an old git reports a deleted worktree directory as healthy and every consumer of
    // `prunable` (staleness, orphan adoption) believes it.
    return worktreeOps.worktreeList(git, repoPath, async (p) => fs.existsSync(p))
  }
  worktreeAdd(repoPath: string, wtPath: string, branch: string, baseRef: string, isNew: boolean) {
    return worktreeOps.worktreeAdd(git, repoPath, wtPath, branch, baseRef, isNew)
  }
  worktreeMerge(repoPath: string, branch: string, baseRef: string, push = false) {
    return worktreeOps.worktreeMerge(git, repoPath, branch, baseRef, push)
  }
  worktreeRemove(repoPath: string, wtPath: string, deleteBranch: boolean, pruneOnly = false) {
    // `pathExists` is git's `prunable` flag's fallback for git < 2.36 (see worktree-ops).
    return worktreeOps.worktreeRemove(git, repoPath, wtPath, os.homedir(), deleteBranch, pruneOnly, async (p) =>
      fs.existsSync(p)
    )
  }

  async status(cwd: string): Promise<GitStatus> {
    const empty: GitStatus = {
      hasRepo: false,
      repoName: '',
      branch: '',
      branches: [],
      ahead: 0,
      behind: 0,
      hasRemote: false,
      hasUpstream: false,
      ghAvailable: !!GH_PATH,
      ghAuthed: false,
      staged: [],
      changes: []
    }
    if (!cwd) return empty

    const inside = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (!inside.ok || inside.out.trim() !== 'true') {
      return { ...empty, repoName: path.basename(cwd) }
    }

    // These reads are independent of each other; run them concurrently instead of
    // serially spawning ~10 git processes one after the next. (`remote get-url origin`
    // simply fails to empty when there's no origin, so it needn't wait on `remote`.)
    const [branchR, branchesR, remotesR, originR, countsR, upstreamR, cachedR, workR, porcelainR, gh] =
      await Promise.all([
        git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(cwd, ['branch', '--format=%(refname:short)']),
        git(cwd, ['remote']),
        git(cwd, ['remote', 'get-url', 'origin']),
        git(cwd, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
        // Resolves only when the current branch has an upstream tracking ref —
        // distinguishes "never pushed (Publish Branch)" from "has upstream (Push/Pull/Sync)".
        git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']),
        git(cwd, ['diff', '--cached', '--numstat']),
        git(cwd, ['diff', '--numstat']),
        git(cwd, ['status', '--porcelain']),
        ghAuthed()
      ])

    const branch = branchR.out.trim() || 'HEAD'
    const branches = branchesR.out.split('\n').map((b) => b.trim()).filter(Boolean)
    const hasRemote = !!remotesR.out.trim()
    const hasUpstream = upstreamR.ok && !!upstreamR.out.trim()
    const originUrl = originR.out.trim()
    const repoName = originUrl ? parseRepoName(originUrl, path.basename(cwd)) : path.basename(cwd)

    let ahead = 0
    let behind = 0
    if (countsR.ok && countsR.out) {
      const [b, a] = countsR.out.trim().split(/\s+/)
      behind = Number(b) || 0
      ahead = Number(a) || 0
    }

    const cachedStat = parseNumstat(cachedR.out)
    const workStat = parseNumstat(workR.out)

    const staged: GitFileChange[] = []
    const changes: GitFileChange[] = []
    const porcelain = porcelainR.out
    for (const raw of porcelain.split('\n').filter(Boolean)) {
      const x = raw[0]
      const y = raw[1]
      let p = raw.slice(3)
      if (p.includes(' -> ')) p = p.split(' -> ')[1] // rename: use new path
      const unquoted = p.replace(/^"|"$/g, '')

      if (x === '?' && y === '?') {
        changes.push({ path: unquoted, status: 'U', added: 0, deleted: 0 })
        continue
      }
      if (x !== ' ' && x !== '?') {
        const s = cachedStat.get(unquoted)
        staged.push({ path: unquoted, status: x, added: s?.added ?? 0, deleted: s?.deleted ?? 0 })
      }
      if (y !== ' ' && y !== '?') {
        const s = workStat.get(unquoted)
        changes.push({ path: unquoted, status: y, added: s?.added ?? 0, deleted: s?.deleted ?? 0 })
      }
    }

    return {
      hasRepo: true,
      repoName,
      branch,
      branches,
      ahead,
      behind,
      hasRemote,
      hasUpstream,
      ghAvailable: !!GH_PATH,
      ghAuthed: gh,
      staged,
      changes
    }
  }

  async diff(cwd: string, p: string, staged: boolean, untracked: boolean): Promise<string> {
    if (!cwd || !p) return ''
    if (untracked) {
      // No-index diff against /dev/null shows the whole file as additions (exits 1).
      const r = await git(cwd, ['diff', '--no-index', '--', '/dev/null', p])
      return r.out || r.err
    }
    const args = staged ? ['diff', '--cached', '--', p] : ['diff', '--', p]
    const r = await git(cwd, args)
    return r.out
  }

  async discard(cwd: string, p: string, untracked: boolean): Promise<GitResult> {
    if (untracked) {
      const r = await git(cwd, ['clean', '-f', '--', p])
      return r.ok ? { ok: true, message: '' } : fail(r)
    }
    const r = await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', p])
    return r.ok ? { ok: true, message: '' } : fail(r)
  }

  async switchBranch(cwd: string, name: string): Promise<GitResult> {
    if (!isValidRef(name)) return { ok: false, message: 'Invalid branch name.' }
    const r = await git(cwd, ['switch', name.trim()])
    return r.ok ? { ok: true, message: `Switched to ${name.trim()}.` } : fail(r)
  }

  async showFile(cwd: string, ref: string, p: string): Promise<string> {
    if (!cwd || !p) return ''
    const spec = ref ? `${ref}:${p}` : `:${p}`
    const r = await git(cwd, ['show', spec])
    return r.ok ? r.out : ''
  }

  async history(cwd: string, options?: GitHistoryOptions | null): Promise<GitHistoryResult> {
    // A default parameter is not enough: over WS-RPC (Server Edition) the args array is
    // JSON-round-tripped, so the renderer's trailing `undefined` arrives as `null` and the default
    // never fires. Normalize explicitly, or every history call throws in the browser.
    const opts = options ?? {}
    if (!cwd) {
      return { items: [], hasIncomingChanges: false, hasOutgoingChanges: false, hasMore: false, limit: opts.limit ?? 50 }
    }
    // Adapt the shared executor (throws on failure) onto our env-configured git runner.
    return loadGitHistoryFromExecutor(
      async (args, dir) => {
        const { stdout } = await run('git', args, { cwd: dir, env: GIT_ENV, maxBuffer: 50 * 1024 * 1024 })
        return { stdout }
      },
      cwd,
      opts
    )
  }

  /** Files changed by a single commit (parent↔commit; `--root` so the initial commit shows). */
  async commitFiles(cwd: string, oid: string): Promise<GitFileChange[]> {
    if (!cwd || !/^[0-9a-fA-F]{7,64}$/.test(oid)) return []
    const [namesR, statR] = await Promise.all([
      git(cwd, ['diff-tree', '--no-commit-id', '--root', '-r', '-z', '--name-status', oid]),
      git(cwd, ['diff-tree', '--no-commit-id', '--root', '-r', '--numstat', oid])
    ])
    const stat = parseNumstat(statR.out)
    const files: GitFileChange[] = []
    const tokens = namesR.out.split('\0').filter(Boolean)
    for (let i = 0; i < tokens.length; ) {
      const status = tokens[i]![0] ?? 'M'
      if (status === 'R' || status === 'C') {
        const newPath = tokens[i + 2] ?? ''
        const s = stat.get(newPath)
        files.push({ path: newPath, status, added: s?.added ?? 0, deleted: s?.deleted ?? 0 })
        i += 3
      } else {
        const p = tokens[i + 1] ?? ''
        const s = stat.get(p)
        files.push({ path: p, status, added: s?.added ?? 0, deleted: s?.deleted ?? 0 })
        i += 2
      }
    }
    return files
  }

  /** Build a provider web URL for a commit from the origin remote; null if unsupported. */
  async remoteCommitUrl(cwd: string, sha: string): Promise<string | null> {
    if (!cwd || !/^[0-9a-fA-F]{7,64}$/.test(sha)) return null
    const r = await git(cwd, ['remote', 'get-url', 'origin'])
    if (!r.ok) return null
    const url = r.out.trim()
    const m =
      url.match(/^git@([^:]+):(.+?)(?:\.git)?$/) ||
      url.match(/^ssh:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/) ||
      url.match(/^https?:\/\/(?:[^@]+@)?([^/]+)\/(.+?)(?:\.git)?$/)
    if (!m) return null
    const host = m[1]
    const repoPath = m[2]
    if (/(^|\.)github\.com$/.test(host) || /(^|\.)gitlab\.com$/.test(host)) {
      return `https://${host}/${repoPath}/commit/${sha}`
    }
    if (/(^|\.)bitbucket\.org$/.test(host)) {
      return `https://${host}/${repoPath}/commits/${sha}`
    }
    return null
  }

  async createBranch(cwd: string, name: string): Promise<GitResult> {
    if (!name.trim()) return { ok: false, message: 'Branch name is empty.' }
    if (!isValidRef(name)) return { ok: false, message: 'Invalid branch name.' }
    const r = await git(cwd, ['switch', '-c', name.trim()])
    return r.ok ? { ok: true, message: `Created ${name.trim()}.` } : fail(r)
  }

  async merge(cwd: string, ref: string): Promise<GitResult> {
    if (!isValidRef(ref)) return { ok: false, message: 'Invalid branch name.' }
    const r = await git(cwd, ['merge', ref.trim()])
    return r.ok ? { ok: true, message: r.out || `Merged ${ref.trim()}.` } : fail(r)
  }

  async rebase(cwd: string, onto: string): Promise<GitResult> {
    if (!isValidRef(onto)) return { ok: false, message: 'Invalid branch name.' }
    const r = await git(cwd, ['rebase', onto.trim()])
    return r.ok ? { ok: true, message: r.out || `Rebased onto ${onto.trim()}.` } : fail(r)
  }

  async deleteBranch(cwd: string, name: string, force: boolean): Promise<GitResult> {
    if (!isValidRef(name)) return { ok: false, message: 'Invalid branch name.' }
    const r = await git(cwd, ['branch', force ? '-D' : '-d', name.trim()])
    return r.ok ? { ok: true, message: `Deleted ${name.trim()}.` } : fail(r)
  }

  async renameBranch(cwd: string, newName: string): Promise<GitResult> {
    if (!isValidRef(newName)) return { ok: false, message: 'Invalid branch name.' }
    const r = await git(cwd, ['branch', '-m', newName.trim()])
    return r.ok ? { ok: true, message: `Renamed to ${newName.trim()}.` } : fail(r)
  }

  async fetch(cwd: string): Promise<GitResult> {
    const r = await git(cwd, ['fetch', '--all', '--prune'])
    return r.ok ? { ok: true, message: r.out || 'Fetched.' } : fail(r)
  }

  async forcePush(cwd: string): Promise<GitResult> {
    const r = await git(cwd, ['push', '--force-with-lease'])
    return r.ok ? { ok: true, message: 'Force-pushed.' } : fail(r)
  }

  async stashPush(cwd: string): Promise<GitResult> {
    const r = await git(cwd, ['stash', 'push', '-u'])
    return r.ok ? { ok: true, message: r.out || 'Stashed.' } : fail(r)
  }

  async stashPop(cwd: string): Promise<GitResult> {
    const r = await git(cwd, ['stash', 'pop'])
    return r.ok ? { ok: true, message: r.out || 'Popped stash.' } : fail(r)
  }

  async revert(cwd: string, oid: string): Promise<GitResult> {
    if (!/^[0-9a-fA-F]{7,64}$/.test(oid)) return { ok: false, message: 'Invalid commit.' }
    const r = await git(cwd, ['revert', '--no-edit', oid])
    return r.ok ? { ok: true, message: r.out || 'Reverted.' } : fail(r)
  }

  async branchAt(cwd: string, name: string, oid: string): Promise<GitResult> {
    if (!isValidRef(name)) return { ok: false, message: 'Invalid branch name.' }
    if (!/^[0-9a-fA-F]{7,64}$/.test(oid)) return { ok: false, message: 'Invalid commit.' }
    const r = await git(cwd, ['switch', '-c', name.trim(), oid])
    return r.ok ? { ok: true, message: `Created ${name.trim()}.` } : fail(r)
  }

  async checkoutCommit(cwd: string, oid: string): Promise<GitResult> {
    if (!/^[0-9a-fA-F]{7,64}$/.test(oid)) return { ok: false, message: 'Invalid commit.' }
    const r = await git(cwd, ['checkout', '--detach', oid])
    return r.ok ? { ok: true, message: `Checked out ${oid.slice(0, 7)} (detached).` } : fail(r)
  }

  /**
   * Clone a repo into parentDir with live progress (IPC.gitCloneProgress) and abort
   * support. Resolves at the END of the clone; success message = the cloned path.
   * The target dir is claimed with a non-recursive mkdir: EEXIST is a friendly error,
   * and on failure/abort we only ever delete the directory WE created this run.
   */
  async clone(parentDir: string, rawUrl: string): Promise<GitResult> {
    if (activeClone) return { ok: false, message: 'A clone is already running.' }
    const url = expandCloneUrl(rawUrl ?? '')
    if (!parentDir || !url) return { ok: false, message: 'Folder and URL are required.' }
    if (!isValidCloneUrl(url)) return { ok: false, message: 'Invalid repository URL.' }
    const dirName = deriveRepoDirName(url)
    if (!dirName) return { ok: false, message: 'Could not derive a folder name from that URL.' }
    const clonePath = path.join(parentDir, dirName)
    // Reserve the single-flight slot synchronously, BEFORE the mkdir await, so a
    // concurrent clone() can't slip past the guard during the await. child is filled
    // in once spawned; cloneAbort() guards against the null window.
    const rec: ActiveClone = { child: null, clonePath, aborted: false }
    activeClone = rec
    try {
      await fs.promises.mkdir(clonePath) // non-recursive claim; also validates parent exists
    } catch (e) {
      activeClone = null
      const err = e as NodeJS.ErrnoException
      if (err.code === 'EEXIST') {
        return {
          ok: false,
          message: `Destination already exists: ${clonePath}. Pick another folder or open it directly.`
        }
      }
      return { ok: false, message: `Cannot create ${clonePath}: ${err.message}` }
    }
    return await new Promise<GitResult>((resolve) => {
      const child = spawn('git', ['clone', '--progress', '--', url, clonePath], {
        cwd: parentDir,
        env: GIT_ENV,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      rec.child = child
      let tail = '' // last 4 KB of stderr for the error message
      child.stderr?.on('data', (d: Buffer) => {
        const text = d.toString('utf-8')
        tail = (tail + text).slice(-4096)
        const p = parseCloneProgress(text)
        if (p) platform().broadcast(IPC.gitCloneProgress, p)
      })
      // Failure/abort: remove the dir we claimed (never anything pre-existing).
      const finishFail = (message: string): void => {
        activeClone = null
        void fs.promises.rm(clonePath, { recursive: true, force: true })
        resolve({ ok: false, message })
      }
      child.on('error', (e) => finishFail(`git could not start: ${e.message}`))
      child.on('close', (code) => {
        if (rec.aborted) return finishFail('aborted')
        if (code === 0) {
          activeClone = null
          resolve({ ok: true, message: clonePath })
          return
        }
        const clean = stripAnsiCodes(tail)
        const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean)
        const fatal = [...lines].reverse().find((l) => /^(fatal|error):/i.test(l))
        finishFail(fatal ?? lines.pop() ?? 'Clone failed.')
      })
    })
  }

  /** Abort the in-flight clone (no-op when idle). */
  cloneAbort(): void {
    if (!activeClone) return
    activeClone.aborted = true
    // child may be null during the reservation→spawn window; the close handler still
    // honors `aborted` once the process starts.
    activeClone.child?.kill('SIGTERM')
  }

  /** ~/projects when present, else the home dir. */
  cloneDefaultParent(): string {
    const p = path.join(os.homedir(), 'projects')
    try {
      if (fs.statSync(p).isDirectory()) return p
    } catch {
      /* fall through */
    }
    return os.homedir()
  }

  async init(cwd: string): Promise<GitResult> {
    if (!cwd) return { ok: false, message: 'No project folder set.' }
    const r = await git(cwd, ['init', '-b', 'main'])
    return r.ok ? { ok: true, message: 'Initialized repository.' } : fail(r)
  }

  async stage(cwd: string, paths: string[]): Promise<GitResult> {
    if (paths.length === 0) return { ok: true, message: '' }
    const r = await git(cwd, ['add', '--', ...paths])
    return r.ok ? { ok: true, message: '' } : fail(r)
  }

  async unstage(cwd: string, paths: string[]): Promise<GitResult> {
    if (paths.length === 0) return { ok: true, message: '' }
    const r = await git(cwd, ['restore', '--staged', '--', ...paths])
    return r.ok ? { ok: true, message: '' } : fail(r)
  }

  async stageAll(cwd: string): Promise<GitResult> {
    const r = await git(cwd, ['add', '-A'])
    return r.ok ? { ok: true, message: '' } : fail(r)
  }

  async unstageAll(cwd: string): Promise<GitResult> {
    const r = await git(cwd, ['reset'])
    return r.ok ? { ok: true, message: '' } : fail(r)
  }

  async commit(cwd: string, message: string): Promise<GitResult> {
    if (!message.trim()) return { ok: false, message: 'Commit message is empty.' }
    const c = await git(cwd, ['commit', '-m', message])
    return c.ok ? { ok: true, message: c.out || 'Committed.' } : fail(c)
  }

  async push(cwd: string): Promise<GitResult> {
    const r = await git(cwd, ['push'])
    if (r.ok) return { ok: true, message: 'Pushed.' }
    if (/no upstream|has no upstream|set-upstream/i.test(r.err)) {
      const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || 'main'
      const up = await git(cwd, ['push', '-u', 'origin', branch])
      return up.ok ? { ok: true, message: 'Pushed (set upstream).' } : fail(up)
    }
    return fail(r)
  }

  async pull(cwd: string): Promise<GitResult> {
    const r = await git(cwd, ['pull'])
    return r.ok ? { ok: true, message: r.out || 'Pulled.' } : fail(r)
  }

  async sync(cwd: string): Promise<GitResult> {
    const pull = await this.pull(cwd)
    if (!pull.ok) return pull
    return this.push(cwd)
  }

  async publish(cwd: string, name: string, isPrivate: boolean): Promise<GitResult> {
    if (!GH_PATH) return { ok: false, message: 'GitHub CLI (gh) not found.' }
    const repo = (name || '').trim()
    // GitHub repo names (optionally `owner/repo`) are limited to these chars and
    // must not start with `-`, so gh can't read the value as an option flag.
    if (!repo || repo.startsWith('-') || !/^[A-Za-z0-9._/-]+$/.test(repo)) {
      return { ok: false, message: 'Invalid repository name.' }
    }
    // Prefer gh's own login; otherwise reuse the user's existing git HTTPS token
    // (the one that already lets them push) so publishing doesn't demand a separate
    // `gh auth login`. If neither is available, signal the UI to start a login.
    const env: NodeJS.ProcessEnv = { ...GIT_ENV }
    if (!(await ghAuthed())) {
      const token = await githubTokenFromGitCredentials(cwd)
      if (!token) {
        return { ok: false, message: 'Sign in to GitHub to publish.', needsAuth: true }
      }
      env.GH_TOKEN = token
    }
    try {
      await run(
        GH_PATH,
        ['repo', 'create', repo, isPrivate ? '--private' : '--public', '--source=.', '--push'],
        { cwd, env, maxBuffer: 10 * 1024 * 1024 }
      )
      return { ok: true, message: 'Published to GitHub.' }
    } catch (e) {
      const err = e as { stderr?: string; message?: string }
      const msg = (err.stderr || err.message || 'gh failed').trim()
      // A reused token without repo-create scope (or an expired one) reads as an auth
      // failure — let the UI offer a full login rather than a dead-end error.
      if (/\b(401|403)\b|unauthor|forbidden|auth|token|scope|HTTP 4/i.test(msg)) {
        return { ok: false, message: msg, needsAuth: true }
      }
      return { ok: false, message: msg }
    }
  }
}

function fail(e: Exec): GitResult {
  return { ok: false, message: e.err || e.out || 'git command failed' }
}
