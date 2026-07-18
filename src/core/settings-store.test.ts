import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { SettingsStore } from './settings-store'
import { DEFAULT_SETTINGS } from '../shared/types'

describe('SettingsStore nested-default merge', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'nodeterm-settings-store-'))
    initPlatform(fakePlatform({ userDataDir: dir }))
  })

  afterEach(() => {
    resetPlatformForTests()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fills a missing nested speech.shortcut from an OLD settings.json (speech present, shortcut absent)', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ fontSize: 15, speech: { engine: 'whisper', model: 'tiny', language: 'auto' } }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    const s = store.get()
    expect(s.speech.shortcut).toBe(DEFAULT_SETTINGS.speech.shortcut)
    // Sibling nested fields the old file DID set must survive the merge untouched.
    expect(s.speech.engine).toBe('whisper')
    expect(s.speech.model).toBe('tiny')
    // Top-level fields the old file set must survive too (shallow-merge path unaffected).
    expect(s.fontSize).toBe(15)
  })

  it('leaves an already-modern speech object alone', () => {
    writeFileSync(
      path.join(dir, 'settings.json'),
      // Deliberately a different combo than DEFAULT_SETTINGS.speech.shortcut, so this test can't
      // pass by accident if the merge ever silently fell back to the default instead of preserving
      // the file's explicit value.
      JSON.stringify({ speech: { engine: 'cloud', model: 'base', language: 'tr', shortcut: 'Cmd+Shift+D' } }),
      'utf-8'
    )
    const store = new SettingsStore()
    store.init()
    expect(store.get().speech).toEqual({
      engine: 'cloud',
      model: 'base',
      language: 'tr',
      shortcut: 'Cmd+Shift+D'
    })
  })

  it('defaults speech entirely when settings.json has no speech object at all', () => {
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ fontSize: 15 }), 'utf-8')
    const store = new SettingsStore()
    store.init()
    expect(store.get().speech).toEqual(DEFAULT_SETTINGS.speech)
  })

  it('defaults everything when settings.json does not exist', () => {
    const store = new SettingsStore()
    store.init()
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })
})
