import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { materializeSharedPaths } from './worktree-shared-paths'

let base: string
let repoRoot: string
let worktreeRoot: string

beforeEach(async () => {
  base = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-wsp-'))
  repoRoot = path.join(base, 'repo')
  worktreeRoot = path.join(base, 'wt')
  await fs.mkdir(repoRoot, { recursive: true })
  await fs.mkdir(worktreeRoot, { recursive: true })
})
afterEach(async () => {
  await fs.rm(base, { recursive: true, force: true })
})

function statusOf(results: { path: string; status: string }[], p: string): string | undefined {
  return results.find((r) => r.path === p)?.status
}

describe('materializeSharedPaths', () => {
  it('symlinks a file and a directory, readable through the link', async () => {
    await fs.writeFile(path.join(repoRoot, '.env'), 'SECRET=1', 'utf-8')
    await fs.mkdir(path.join(repoRoot, 'node_modules', 'pkg'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports=1', 'utf-8')

    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['.env', 'node_modules'])

    expect(statusOf(res, '.env')).toBe('linked')
    expect(statusOf(res, 'node_modules')).toBe('linked')

    // Read through the links.
    expect(await fs.readFile(path.join(worktreeRoot, '.env'), 'utf-8')).toBe('SECRET=1')
    expect(await fs.readFile(path.join(worktreeRoot, 'node_modules', 'pkg', 'index.js'), 'utf-8')).toBe(
      'module.exports=1'
    )

    // The link actually points at the source.
    const link = await fs.readlink(path.join(worktreeRoot, '.env'))
    expect(path.resolve(worktreeRoot, link)).toBe(path.join(repoRoot, '.env'))
  })

  it('skips a missing source (fresh clone, deps not installed)', async () => {
    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['node_modules'])
    expect(statusOf(res, 'node_modules')).toBe('skipped-missing-source')
    // No stray link created.
    await expect(fs.lstat(path.join(worktreeRoot, 'node_modules'))).rejects.toBeTruthy()
  })

  it('never overwrites an existing target (even a broken symlink)', async () => {
    await fs.writeFile(path.join(repoRoot, '.env'), 'FROM_REPO', 'utf-8')
    // Pre-existing real file in the worktree.
    await fs.writeFile(path.join(worktreeRoot, '.env'), 'ALREADY_HERE', 'utf-8')
    // Pre-existing broken symlink.
    await fs.mkdir(path.join(repoRoot, 'dir'), { recursive: true })
    await fs.symlink(path.join(base, 'does-not-exist'), path.join(worktreeRoot, 'dir'))

    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['.env', 'dir'])

    expect(statusOf(res, '.env')).toBe('skipped-exists')
    expect(statusOf(res, 'dir')).toBe('skipped-exists')
    // The real file is untouched.
    expect(await fs.readFile(path.join(worktreeRoot, '.env'), 'utf-8')).toBe('ALREADY_HERE')
    // The broken symlink is left exactly as it was.
    expect(await fs.readlink(path.join(worktreeRoot, 'dir'))).toBe(path.join(base, 'does-not-exist'))
  })

  it('rejects absolute and traversal entries as unsafe', async () => {
    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['/etc/passwd', '../escape', 'a/../../x'])
    expect(statusOf(res, '/etc/passwd')).toBe('skipped-unsafe')
    expect(statusOf(res, '../escape')).toBe('skipped-unsafe')
    expect(statusOf(res, 'a/../../x')).toBe('skipped-unsafe')
  })

  it('reserves .git and anything under it', async () => {
    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['.git', '.git/hooks', '.GIT'])
    expect(statusOf(res, '.git')).toBe('skipped-reserved')
    expect(statusOf(res, '.git/hooks')).toBe('skipped-reserved')
    expect(statusOf(res, '.GIT')).toBe('skipped-reserved')
  })

  it('creates intermediate parent dirs for a nested target', async () => {
    await fs.mkdir(path.join(repoRoot, 'a', 'b'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'a', 'b', 'c.txt'), 'nested', 'utf-8')
    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['a/b/c.txt'])
    expect(statusOf(res, 'a/b/c.txt')).toBe('linked')
    expect(await fs.readFile(path.join(worktreeRoot, 'a', 'b', 'c.txt'), 'utf-8')).toBe('nested')
  })

  it('returns a result per entry and never throws, even for a nonexistent worktree root', async () => {
    await fs.writeFile(path.join(repoRoot, '.env'), 'x', 'utf-8')
    const res = await materializeSharedPaths(repoRoot, path.join(base, 'missing-wt', 'deep'), ['.env'])
    // Either linked (mkdir -p created the tree) — but never a throw and always one result.
    expect(res).toHaveLength(1)
    expect(res[0].path).toBe('.env')
  })

  it('returns an empty list for no shared paths', async () => {
    expect(await materializeSharedPaths(repoRoot, worktreeRoot, [])).toEqual([])
  })

  // Security: `git worktree add` checks out attacker-controllable TRACKED symlinks, so the lexical
  // within-root guard is insufficient — a link can be planted OUTSIDE the worktree/repo THROUGH an
  // intermediate symlink. The realpath-of-deepest-existing-ancestor checks are the authoritative
  // containment guards.
  it('refuses a target that escapes the worktree through an intermediate symlink (plant primitive)', async () => {
    // A real source so we get past the missing-source check and reach the target guard.
    await fs.mkdir(path.join(repoRoot, 'cfg'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'cfg', 'x'), 'PAYLOAD', 'utf-8')
    // The checked-out worktree contains `cfg` as a symlink pointing OUTSIDE the worktree root.
    const outside = path.join(base, 'outside')
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, path.join(worktreeRoot, 'cfg'))

    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['cfg/x'])

    expect(statusOf(res, 'cfg/x')).toBe('skipped-unsafe')
    // Nothing was planted at the escape location.
    await expect(fs.lstat(path.join(outside, 'x'))).rejects.toBeTruthy()
  })

  it('refuses a source that escapes the repo through an intermediate symlink', async () => {
    // Outside-the-repo content the hostile symlink points at.
    const outside = path.join(base, 'outside-repo')
    await fs.mkdir(outside, { recursive: true })
    await fs.writeFile(path.join(outside, 'secret'), 'LEAKED', 'utf-8')
    // A tracked symlink inside the repo that escapes it.
    await fs.symlink(outside, path.join(repoRoot, 'evil'))

    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['evil/secret'])

    expect(statusOf(res, 'evil/secret')).toBe('skipped-unsafe')
    // Materialization surfaced nothing from outside the repo.
    await expect(fs.lstat(path.join(worktreeRoot, 'evil', 'secret'))).rejects.toBeTruthy()
  })

  it('does not mkdir -p through an intermediate symlink outside the worktree (empty-dir plant)', async () => {
    // A real deep source so we get past the missing-source check and reach the parent-creation step.
    await fs.mkdir(path.join(repoRoot, 'cfg', 'deep'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'cfg', 'deep', 'x'), 'PAYLOAD', 'utf-8')
    // The checked-out worktree has `cfg` as a symlink OUTSIDE the worktree; `mkdir -p <wt>/cfg/deep`
    // would follow it and create `<outside>/deep` before any post-mkdir guard.
    const outside = path.join(base, 'outside-mkdir')
    await fs.mkdir(outside, { recursive: true })
    await fs.symlink(outside, path.join(worktreeRoot, 'cfg'))

    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['cfg/deep/x'])

    expect(statusOf(res, 'cfg/deep/x')).toBe('skipped-unsafe')
    // The mkdir must NOT have run through the symlink.
    await expect(fs.lstat(path.join(outside, 'deep'))).rejects.toBeTruthy()
  })

  it('still links a legitimate in-repo symlink source (realpath stays under the repo root)', async () => {
    await fs.mkdir(path.join(repoRoot, 'real'), { recursive: true })
    await fs.writeFile(path.join(repoRoot, 'real', 'f'), 'INREPO', 'utf-8')
    // A relative, in-repo symlink — resolves back under the repo, so it is allowed.
    await fs.symlink('./real', path.join(repoRoot, 'link'))

    const res = await materializeSharedPaths(repoRoot, worktreeRoot, ['link/f'])

    expect(statusOf(res, 'link/f')).toBe('linked')
    expect(await fs.readFile(path.join(worktreeRoot, 'link', 'f'), 'utf-8')).toBe('INREPO')
  })
})
