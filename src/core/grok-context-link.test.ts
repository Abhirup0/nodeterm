// grok's leg of context-link: the locator, the path jail, and the capability membership.
//
// The trap this file exists to pin: grok's hook payloads DO carry a transcript path (measured on
// 1.0.13, 2026-09-01 — the doc claimed otherwise for months), and it points at `updates.jsonl`.
// The readable conversation is `chat_history.jsonl`, its SIBLING in the same session directory.
// Routing this feature through the path the hooks advertise therefore fails SILENTLY: a real file
// is read, `linesFromGrok` finds no line it recognises, and the linked agent is shown an empty
// transcript with no error anywhere. A comment cannot go red, so this is a test.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { canContextLink } from '../shared/agents/config'
import { isSafeLocalTranscriptPath } from './claude-accounts-core'
import { forgetGrokSession, rememberGrokSessionDir } from './grok-session'
import { locateGrok } from './handoff/locate'
import { GROK_CHAT_HISTORY_FILE, GROK_UPDATES_FILE } from './agents/grok-paths'

const SESSION = '00000000-0000-4000-8000-000000000001'
let dir = ''

beforeEach(() => {
  forgetGrokSession(SESSION)
  dir = mkdtempSync(path.join(tmpdir(), 'grok-link-'))
})

describe('locateGrok', () => {
  it('resolves the READABLE transcript, not the one the hooks advertise', async () => {
    writeFileSync(path.join(dir, GROK_CHAT_HISTORY_FILE), '{"type":"user","content":"hi"}\n')
    writeFileSync(path.join(dir, GROK_UPDATES_FILE), '{"anything":"the hook payload points here"}\n')
    rememberGrokSessionDir(SESSION, dir)
    const found = await locateGrok(SESSION)
    expect(found).toBe(path.join(dir, GROK_CHAT_HISTORY_FILE))
    expect(found).not.toContain(GROK_UPDATES_FILE)
  })

  it('learns nothing rather than guessing when no hook has reported the directory', async () => {
    // Derived from what a hook told us, never searched: a scan of grok's sessions tree is how one
    // node ends up reading another node's conversation.
    expect(await locateGrok(SESSION)).toBeUndefined()
  })

  it('returns undefined when the session directory holds no chat history yet', async () => {
    rememberGrokSessionDir(SESSION, dir)
    expect(await locateGrok(SESSION)).toBeUndefined()
  })
})

describe('the transcript path jail', () => {
  const home = '/home/user'
  const userData = '/data'
  it('admits grok session files under its own root', () => {
    const p = path.join(home, '.grok', 'sessions', 'enc', SESSION, GROK_CHAT_HISTORY_FILE)
    expect(isSafeLocalTranscriptPath(p, home, userData, undefined, path.join(home, '.grok'))).toBe(true)
  })
  it('honours a relocated $GROK_HOME, and stops admitting the default one', () => {
    const moved = '/elsewhere/grok'
    const p = path.join(moved, 'sessions', 'enc', SESSION, GROK_CHAT_HISTORY_FILE)
    expect(isSafeLocalTranscriptPath(p, home, userData, undefined, moved)).toBe(true)
    expect(isSafeLocalTranscriptPath(path.join(home, '.grok', 'sessions', 'x'), home, userData, undefined, moved)).toBe(
      false
    )
  })
  it('is a per-ROOT widening, never $HOME', () => {
    for (const bad of [path.join(home, '.ssh', 'id_rsa'), path.join(home, '.grok', 'auth.json'), home]) {
      expect(isSafeLocalTranscriptPath(bad, home, userData, undefined, path.join(home, '.grok'))).toBe(false)
    }
  })
})

describe('capability membership', () => {
  it('lets grok read a linked node', () => {
    expect(canContextLink('grok')).toBe(true)
  })
})

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})
