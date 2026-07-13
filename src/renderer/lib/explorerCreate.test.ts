import { describe, expect, it } from 'vitest'
import { ancestorDirs, createTargetDir, newEntryPath, parentDir } from './explorerCreate'

describe('createTargetDir', () => {
  it('a dir targets itself, a file targets its parent', () => {
    expect(createTargetDir('/repo/src', true)).toBe('/repo/src')
    expect(createTargetDir('/repo/src/a.ts', false)).toBe('/repo/src')
  })
})

describe('parentDir', () => {
  it('strips the last segment', () => {
    expect(parentDir('/repo/src/a.ts')).toBe('/repo/src')
    expect(parentDir('/repo')).toBe('/')
  })
})

describe('newEntryPath', () => {
  it('joins simple and nested names', () => {
    expect(newEntryPath('/repo/src', 'notes.md')).toBe('/repo/src/notes.md')
    expect(newEntryPath('/repo/src/', 'a/b.ts')).toBe('/repo/src/a/b.ts')
  })
  it('rejects empty, absolute, traversal and trailing-slash names', () => {
    expect(newEntryPath('/repo', '')).toBeNull()
    expect(newEntryPath('/repo', '  ')).toBeNull()
    expect(newEntryPath('/repo', '/etc/passwd')).toBeNull()
    expect(newEntryPath('/repo', '../evil')).toBeNull()
    expect(newEntryPath('/repo', 'a/../../evil')).toBeNull()
    expect(newEntryPath('/repo', 'a/')).toBeNull()
  })
})

describe('ancestorDirs', () => {
  it('lists the intermediate dirs a nested name creates', () => {
    expect(ancestorDirs('/repo', 'a/b/c.ts')).toEqual(['/repo/a', '/repo/a/b'])
    expect(ancestorDirs('/repo', 'c.ts')).toEqual([])
  })
})
