import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { listGrokSessionIds } from './grok-session-mint'
import { mintFreeGrokSessionId } from '../shared/agents/grok-session-mint'
import { grokEncodedCwdDirName } from './agents/grok-paths'

const ID_A = '01a06126-b981-73f1-8b68-4547e4d7da84'
const ID_B = '01a06126-b981-79f2-ad74-af463c662107'

describe('mintFreeGrokSessionId', () => {
  it('returns the candidate when nothing owns it', () => {
    expect(mintFreeGrokSessionId(new Set(), () => ID_A)).toBe(ID_A)
  })

  it('mints ANOTHER id when the first one already exists on disk', () => {
    // The whole point. grok refuses an id that already exists under the session directory — that is
    // a launch error, not a resume, so reusing it means the node never starts.
    const seq = [ID_A, ID_B]
    let i = 0
    expect(mintFreeGrokSessionId(new Set([ID_A]), () => seq[i++])).toBe(ID_B)
  })

  it('gives up rather than returning a taken id, and rather than looping forever', () => {
    // A generator that only ever produces a taken id means something is broken. The safe answer is
    // no id at all — launch without the flag, learn the id from a hook, exactly as before minting
    // existed. Returning the taken one would kill the launch; looping would hang node creation.
    let calls = 0
    const out = mintFreeGrokSessionId(new Set([ID_A]), () => {
      calls++
      return ID_A
    })
    expect(out).toBeUndefined()
    expect(calls).toBe(3)
  })

  it('never returns an empty candidate', () => {
    expect(mintFreeGrokSessionId(new Set(), () => '')).toBeUndefined()
  })
})

describe('listGrokSessionIds', () => {
  it('reads the ids grok already has for that cwd', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-mint-'))
    const cwd = '/Users/someone/Repositories/thing'
    const dir = path.join(root, grokEncodedCwdDirName(cwd)!)
    fs.mkdirSync(path.join(dir, ID_A), { recursive: true })
    fs.mkdirSync(path.join(dir, ID_B), { recursive: true })
    // A stray FILE is not a session: only directory names count.
    fs.writeFileSync(path.join(dir, 'not-a-session.json'), '{}')
    expect(listGrokSessionIds(root, cwd)).toEqual(new Set([ID_A, ID_B]))
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('answers the empty set for a cwd grok has never run in', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-mint-'))
    expect(listGrokSessionIds(root, '/nowhere/at/all')).toEqual(new Set())
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('answers the empty set — never throws — when the root is unreadable', () => {
    // Degrades to "mint freely", not to "refuse to mint": an unreadable directory must not cost the
    // node its session id.
    expect(listGrokSessionIds('/definitely/not/here', '/some/cwd')).toEqual(new Set())
  })
})
