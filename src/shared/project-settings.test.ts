import { describe, it, expect } from 'vitest'
import {
  parseProjectSettingsFile, sanitizeProjectSettingsDoc, sanitizeProjectLocalSettings,
  serializeProjectSettingsFile, sameProjectSettingsContent, resolveProjectSettings,
  projectTrustContent
} from './project-settings'

describe('sanitizeProjectSettingsDoc', () => {
  it('keeps well-formed families and drops unknown keys', () => {
    const doc = sanitizeProjectSettingsDoc({
      setup: { setupScript: 'npm ci', archiveScript: 'echo bye', waitForSetup: true, extra: 1 },
      agents: { launchCmd: 'claude --resume', env: { FOO: 'bar' } },
      bogus: { a: 1 }
    })
    expect(doc).toEqual({
      setup: { setupScript: 'npm ci', archiveScript: 'echo bye', waitForSetup: true },
      agents: { launchCmd: 'claude --resume', env: { FOO: 'bar' } }
    })
  })
  it('drops non-string scalars, oversized strings, and non-true waitForSetup', () => {
    const doc = sanitizeProjectSettingsDoc({
      setup: { setupScript: 42, waitForSetup: 'true' },
      terminal: { shell: 'x'.repeat(1025), theme: 'dark' }
    })
    expect(doc).toEqual({ terminal: { theme: 'dark' } })
  })
  it('rejects env keys that are not valid variable names (incl. __proto__)', () => {
    const doc = sanitizeProjectSettingsDoc({
      agents: { env: { GOOD_1: 'v', 'bad-key': 'v', __proto__: 'x', 'a b': 'v' } }
    })
    expect(doc.agents?.env).toEqual({ GOOD_1: 'v' })
    expect(Object.getPrototypeOf(doc.agents!.env)).toBe(Object.prototype)
  })
  it('drops a hostile __proto__ own-key from a JSON-parsed env object', () => {
    // A literal `__proto__:` in an object initializer sets the prototype rather than an own
    // property, so it can never reach the sanitizer as a key to reject — this is how a hostile
    // settings.json actually delivers the attack: JSON.parse DOES create it as an own property.
    const hostileEnv = JSON.parse('{"__proto__":"x","OK_KEY":"v"}')
    const doc = sanitizeProjectSettingsDoc({ agents: { env: hostileEnv } })
    expect(doc.agents?.env).toEqual({ OK_KEY: 'v' })
    expect(Object.getPrototypeOf(doc.agents!.env)).toBe(Object.prototype)
  })
  it('drops absolute and traversal sharedPaths and dedupes', () => {
    const doc = sanitizeProjectSettingsDoc({
      worktree: { sharedPaths: ['.env', '/etc/passwd', '../up', 'a/../b', 'C:\\x', '.env', 'node_modules'] }
    })
    expect(doc.worktree?.sharedPaths).toEqual(['.env', 'node_modules'])
  })
  it('omits a family whose every field was dropped', () => {
    expect(sanitizeProjectSettingsDoc({ setup: { setupScript: 42 } })).toEqual({})
  })
})

describe('sanitizeProjectLocalSettings', () => {
  it('keeps only literal-true known-family ignoreShared flags', () => {
    const local = sanitizeProjectLocalSettings({
      terminal: { shell: '/bin/fish' },
      ignoreShared: { setup: true, agents: 'yes', bogus: true }
    })
    expect(local).toEqual({ terminal: { shell: '/bin/fish' }, ignoreShared: { setup: true } })
  })
  it('returns undefined for a non-object', () => {
    expect(sanitizeProjectLocalSettings('nope')).toBeUndefined()
  })
})

describe('parseProjectSettingsFile', () => {
  const file = { version: 1, rev: 3, savedAt: '2026-08-19T00:00:00Z', setup: { setupScript: 'make' } }
  it('parses a valid file', () => {
    const r = parseProjectSettingsFile(JSON.stringify(file))
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.file.setup?.setupScript).toBe('make')
  })
  it('reports conflict for a git-conflict-marked file without parsing', () => {
    const raw = '<<<<<<< HEAD\n{"version":1}\n=======\n{"version":1}\n>>>>>>> theirs\n'
    expect(parseProjectSettingsFile(raw).status).toBe('conflict')
  })
  it('reports invalid for wrong version, bad rev, or non-JSON', () => {
    expect(parseProjectSettingsFile(JSON.stringify({ ...file, version: 2 })).status).toBe('invalid')
    expect(parseProjectSettingsFile(JSON.stringify({ ...file, rev: -1 })).status).toBe('invalid')
    expect(parseProjectSettingsFile('{oops').status).toBe('invalid')
  })
})

describe('serialize + content equality', () => {
  it('round-trips and ignores rev/savedAt in content comparison', () => {
    const a = { version: 1 as const, rev: 1, savedAt: 't1', terminal: { shell: '/bin/zsh' } }
    const b = { version: 1 as const, rev: 9, savedAt: 't2', terminal: { shell: '/bin/zsh' } }
    const c = { version: 1 as const, rev: 1, savedAt: 't1', terminal: { shell: '/bin/bash' } }
    expect(parseProjectSettingsFile(serializeProjectSettingsFile(a)).status).toBe('ok')
    expect(sameProjectSettingsContent(a, b)).toBe(true)
    expect(sameProjectSettingsContent(a, c)).toBe(false)
  })
})

describe('resolveProjectSettings', () => {
  const shared = {
    setup: { setupScript: 'npm ci', waitForSetup: true },
    terminal: { shell: '/bin/bash', theme: 'dark' }
  }
  it('local wins per key; shared fills the rest with provenance', () => {
    const r = resolveProjectSettings({ terminal: { shell: '/bin/fish' } }, shared)
    expect(r.terminal.shell).toEqual({ value: '/bin/fish', source: 'local' })
    expect(r.terminal.theme).toEqual({ value: 'dark', source: 'shared' })
    expect(r.setup.setupScript).toEqual({ value: 'npm ci', source: 'shared' })
  })
  it('ignoreShared blanks a family without needing local values', () => {
    const r = resolveProjectSettings({ ignoreShared: { setup: true } }, shared)
    expect(r.setup).toEqual({})
    expect(r.terminal.shell).toEqual({ value: '/bin/bash', source: 'shared' })
  })
  it('ignoreShared still lets a local value through', () => {
    const r = resolveProjectSettings(
      { setup: { setupScript: 'make' }, ignoreShared: { setup: true } }, shared)
    expect(r.setup.setupScript).toEqual({ value: 'make', source: 'local' })
    expect(r.setup.waitForSetup).toBeUndefined()
  })
  it('handles both sides undefined', () => {
    expect(resolveProjectSettings(undefined, undefined)).toEqual(
      { setup: {}, worktree: {}, agents: {}, terminal: {} })
  })
})

describe('projectTrustContent', () => {
  it('covers both scripts and is insensitive to key order', () => {
    expect(projectTrustContent('setup', { setup: { setupScript: 'a' } }))
      .toBe(JSON.stringify({ setupScript: 'a', archiveScript: '' }))
    expect(projectTrustContent('setup', {})).toBeNull()
  })
  it('agents hash covers launchCmd AND env with sorted keys', () => {
    const a = projectTrustContent('agents', { agents: { launchCmd: 'x', env: { B: '2', A: '1' } } })
    const b = projectTrustContent('agents', { agents: { env: { A: '1', B: '2' }, launchCmd: 'x' } })
    expect(a).toBe(b)
    expect(a).toContain('"A":"1"')
    expect(projectTrustContent('agents', { agents: { defaultAgentId: 'claude' } })).toBeNull()
  })
  it('shell content is the bare shell or null', () => {
    expect(projectTrustContent('shell', { terminal: { shell: '/bin/sh' } })).toBe('/bin/sh')
    expect(projectTrustContent('shell', { terminal: { theme: 'dark' } })).toBeNull()
  })
})
