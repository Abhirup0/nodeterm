import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { makeDir, pathExists } from './fs-ops'

const root = mkdtempSync(join(tmpdir(), 'fs-ops-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('makeDir', () => {
  it('creates nested directories recursively', async () => {
    expect(await makeDir(join(root, 'a/b/c'))).toBe(true)
    expect(await pathExists(join(root, 'a/b/c'))).toBe(true)
  })
  it('is idempotent on an existing dir', async () => {
    expect(await makeDir(join(root, 'a'))).toBe(true)
  })
  it('fails open (false) when blocked by a file', async () => {
    writeFileSync(join(root, 'file.txt'), 'x')
    expect(await makeDir(join(root, 'file.txt/sub'))).toBe(false)
  })
})

describe('pathExists', () => {
  it('true for files and dirs, false for missing', async () => {
    expect(await pathExists(join(root, 'file.txt'))).toBe(true)
    expect(await pathExists(join(root, 'a'))).toBe(true)
    expect(await pathExists(join(root, 'nope'))).toBe(false)
  })
})
