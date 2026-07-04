import { describe, it, expect } from 'vitest'
import {
  expandCloneUrl,
  isValidCloneUrl,
  deriveRepoDirName,
  parseCloneProgress,
  stripAnsiCodes
} from './clone-url'

describe('expandCloneUrl', () => {
  it('expands owner/repo shorthand to a GitHub HTTPS URL', () => {
    expect(expandCloneUrl('facebook/react')).toBe('https://github.com/facebook/react.git')
    expect(expandCloneUrl(' torvalds/linux ')).toBe('https://github.com/torvalds/linux.git')
    expect(expandCloneUrl('a-b.c/d_e.git')).toBe('https://github.com/a-b.c/d_e.git')
  })
  it('leaves full URLs and non-shorthand input untouched', () => {
    expect(expandCloneUrl('https://github.com/a/b.git')).toBe('https://github.com/a/b.git')
    expect(expandCloneUrl('git@github.com:a/b.git')).toBe('git@github.com:a/b.git')
    expect(expandCloneUrl('a/b/c')).toBe('a/b/c')
    expect(expandCloneUrl('-x/y')).toBe('-x/y') // never turn a flag-looking string into a URL
  })
})

describe('isValidCloneUrl', () => {
  it('accepts known schemes and scp-style', () => {
    for (const u of [
      'https://github.com/a/b.git',
      'http://host/repo',
      'ssh://git@host/a/b',
      'git://host/a',
      'git@github.com:a/b.git'
    ])
      expect(isValidCloneUrl(u)).toBe(true)
  })
  it('rejects empty, flag-leading and unknown schemes', () => {
    for (const u of ['', '  ', '-https://x', '--upload-pack=/bin/sh', 'file:///etc', 'ftp://x/y'])
      expect(isValidCloneUrl(u)).toBe(false)
  })
})

describe('deriveRepoDirName', () => {
  it('derives the repo folder from common URL shapes', () => {
    expect(deriveRepoDirName('https://github.com/a/repo.git')).toBe('repo')
    expect(deriveRepoDirName('https://github.com/a/repo.git/')).toBe('repo')
    expect(deriveRepoDirName('git@github.com:a/repo.git')).toBe('repo')
    expect(deriveRepoDirName('ssh://git@host/x/y/repo')).toBe('repo')
  })
  it('rejects names that could escape the parent dir', () => {
    expect(deriveRepoDirName('https://host/..')).toBeNull()
    expect(deriveRepoDirName('https://host/.git')).toBeNull()
    expect(deriveRepoDirName('')).toBeNull()
  })
})

describe('parseCloneProgress', () => {
  it('returns the LAST progress line of a chunk', () => {
    const chunk = 'Receiving objects:  10% (1/10)\rReceiving objects:  40% (4/10)\r'
    expect(parseCloneProgress(chunk)).toEqual({ phase: 'Receiving objects', percent: 40 })
  })
  it('parses all git phases and clamps to 100', () => {
    expect(parseCloneProgress('Resolving deltas: 100% (5/5), done.')).toEqual({
      phase: 'Resolving deltas',
      percent: 100
    })
    expect(parseCloneProgress('Counting objects: 120% weird')).toEqual({
      phase: 'Counting objects',
      percent: 100
    })
  })
  it('returns null when a chunk has no percentage', () => {
    expect(parseCloneProgress("Cloning into 'repo'...\n")).toBeNull()
  })
})

describe('stripAnsiCodes', () => {
  it('removes SGR color codes', () => {
    expect(stripAnsiCodes('\x1b[31mfatal:\x1b[0m nope')).toBe('fatal: nope')
  })
})
