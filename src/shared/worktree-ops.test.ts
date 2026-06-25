import { describe, it, expect } from 'vitest'
import { worktreeAdd, worktreeMerge, worktreeRemove, type GitExec } from './worktree-ops'

const ok = (out = ''): GitExec => ({ ok: true, out, err: '' })
const ko = (err = 'fail'): GitExec => ({ ok: false, out: '', err })

/** Fake git executor: returns a canned result keyed by `args.join(' ')`, records every call. */
function fakeGit(handlers: Record<string, GitExec>) {
  const calls: string[][] = []
  const git = async (_cwd: string, args: string[]): Promise<GitExec> => {
    calls.push(args)
    return handlers[args.join(' ')] ?? ok()
  }
  return { git, calls }
}

describe('worktreeAdd', () => {
  it('uses --no-track -b and a -- separator for a new branch', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeAdd(git, '/repo', '/wt/x', 'feature/x', 'main', true)
    expect(r.ok).toBe(true)
    expect(calls[0]).toEqual(['worktree', 'add', '--no-track', '-b', 'feature/x', '--', '/wt/x', 'main'])
  })
  it('uses a -- separator for an existing branch', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeAdd(git, '/repo', '/wt/x', 'feature/x', 'main', false)
    expect(r.ok).toBe(true)
    expect(calls[0]).toEqual(['worktree', 'add', '--', '/wt/x', 'feature/x'])
  })
  it('rejects a flag-injecting branch name without calling git', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeAdd(git, '/repo', '/wt/x', '--evil', 'main', true)
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
  it('rejects a flag-injecting worktree path without calling git', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeAdd(git, '/repo', '--evil', 'feature/x', 'main', true)
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
})

describe('worktreeMerge', () => {
  it('fetch-updates when base is not checked out (no merge call)', async () => {
    const list = 'worktree /wt/x\nHEAD aaa\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main')
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c[0] === 'fetch')).toBe(true)
    expect(calls.some((c) => c[0] === 'merge')).toBe(false)
  })
  it('merges in place and aborts on conflict', async () => {
    const list = 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n'
    const { git, calls } = fakeGit({
      'worktree list --porcelain': ok(list),
      'status --porcelain': ok(''), // base clean
      'merge --no-ff --no-edit feature/x': ko('CONFLICT')
    })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main')
    expect(r.ok).toBe(false)
    expect(calls.some((c) => c.join(' ') === 'merge --abort')).toBe(true)
  })
  it('blocks when the base checkout is dirty', async () => {
    const list = 'worktree /repo\nHEAD aaa\nbranch refs/heads/main\n'
    const { git } = fakeGit({
      'worktree list --porcelain': ok(list),
      'status --porcelain': ok(' M file.ts') // dirty
    })
    const r = await worktreeMerge(git, '/repo', 'feature/x', 'main')
    expect(r.ok).toBe(false)
  })
})

describe('worktreeRemove', () => {
  it('refuses the repo path itself (no git call)', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeRemove(git, '/repo', '/repo', '/home', true)
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
  it('rejects a flag-injecting worktree path without calling git', async () => {
    const { git, calls } = fakeGit({})
    const r = await worktreeRemove(git, '/repo', '--evil', '/home', false)
    expect(r.ok).toBe(false)
    expect(calls.length).toBe(0)
  })
  it('refuses an unregistered worktree path', async () => {
    const { git } = fakeGit({ 'worktree list --porcelain': ok('worktree /repo\nbranch refs/heads/main\n') })
    const r = await worktreeRemove(git, '/repo', '/wt/ghost', '/home', false)
    expect(r.ok).toBe(false)
  })
  it('removes a registered worktree, prunes, and deletes the branch', async () => {
    const list = 'worktree /repo\nbranch refs/heads/main\n\nworktree /wt/x\nbranch refs/heads/feature/x\n'
    const { git, calls } = fakeGit({ 'worktree list --porcelain': ok(list) })
    const r = await worktreeRemove(git, '/repo', '/wt/x', '/home', true)
    expect(r.ok).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'worktree remove --force -- /wt/x')).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'worktree prune')).toBe(true)
    expect(calls.some((c) => c.join(' ') === 'branch -d feature/x')).toBe(true)
  })
})
