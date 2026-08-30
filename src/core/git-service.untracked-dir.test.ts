import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitService } from './git-service'

let directory = ''

afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true })
})

describe('GitService.status untracked directories', () => {
  it('lists individual untracked files instead of collapsing the directory into one entry', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-untracked-dir-'))
    execFileSync('git', ['init', '-q'], { cwd: directory })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: directory })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: directory })

    // A brand-new, entirely untracked subdirectory with two files: git's default
    // `--untracked-files=normal` collapses this into a single `?? newdir/` porcelain line.
    await fs.mkdir(path.join(directory, 'newdir'))
    await fs.writeFile(path.join(directory, 'newdir', 'a.txt'), 'a')
    await fs.writeFile(path.join(directory, 'newdir', 'b.txt'), 'b')

    const service = new GitService()
    const status = await service.status(directory)

    const paths = status.changes.map((c) => c.path).sort()
    expect(paths).toEqual(['newdir/a.txt', 'newdir/b.txt'])
    // No entry should ever be directory-shaped — nothing here can be opened as a file diff.
    expect(status.changes.some((c) => c.path.endsWith('/'))).toBe(false)
    expect(status.staged.some((c) => c.path.endsWith('/'))).toBe(false)
  })
})
