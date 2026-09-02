// The read channels both shells now serve. What these pin down is the DISTINCTION the ⌘M panel
// depends on: "resolved, and the session has said nothing" vs "nothing resolved at all" — the two
// used to be the same empty array, which is how a failed resolution reached the user as an empty
// conversation.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { registerTranscriptIpc } from './transcript-ipc'
import { rememberGrokSessionDir } from './grok-session'
import { IPC } from '../shared/ipc'
import type { ChatTranscriptResult, TranscriptLine } from '../shared/types'

const SID = '46b36ce2-dd77-4f5e-a89e-4a0e831e83df'
const CWD = '/srv/app'

const lines = (...raw: object[]): string => raw.map((o) => JSON.stringify(o)).join('\n') + '\n'
const userLine = (text: string) => ({ type: 'user', message: { content: text } })
const assistantLine = (text: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'text', text }] }
})

let home: string
let f: ReturnType<typeof fakePlatform>

const chat = (nodeId?: string) =>
  f.handlers[IPC.chatReadTranscript](SID, CWD, undefined, nodeId) as Promise<ChatTranscriptResult>
const search = (nodeId?: string) =>
  f.handlers[IPC.claudeReadTranscript](SID, CWD, undefined, nodeId) as Promise<TranscriptLine[]>

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-transcript-ipc-'))
  vi.spyOn(os, 'homedir').mockReturnValue(home)
  f = fakePlatform()
  initPlatform(f)
})
afterEach(() => {
  vi.restoreAllMocks()
  resetPlatformForTests()
  fs.rmSync(home, { recursive: true, force: true })
})

const writeTranscript = (body: string, name = `${SID}.jsonl`): string => {
  const dir = path.join(home, '.claude', 'projects', '-srv-app')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  fs.writeFileSync(p, body)
  return p
}

describe('registerTranscriptIpc — local resolution', () => {
  it('reads the session transcript and reports it found', async () => {
    writeTranscript(lines(userLine('merhaba'), assistantLine('selam')))
    registerTranscriptIpc()
    const res = await chat()
    expect(res.found).toBe(true)
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('distinguishes an EMPTY session (found) from an unresolvable one (not found)', async () => {
    // A transcript that exists but carries no renderable message — a session that was created and
    // never spoken to. Real: 27 of 135 transcripts on the dev box look exactly like this.
    writeTranscript(lines({ type: 'bridge-session', sessionId: SID }))
    registerTranscriptIpc()
    expect(await chat()).toEqual({ messages: [], found: true })

    fs.rmSync(path.join(home, '.claude'), { recursive: true, force: true })
    expect(await chat()).toEqual({ messages: [], found: false })
  })

  it('prefers a hook-fed path over the sessionId scan', async () => {
    writeTranscript(lines(assistantLine('scanned')))
    const hooked = path.join(home, 'elsewhere.jsonl')
    fs.writeFileSync(hooked, lines(assistantLine('hook-fed')))
    registerTranscriptIpc({ pathFor: () => hooked })
    const res = await chat()
    expect(res.messages[0].parts[0]).toMatchObject({ kind: 'text', text: 'hook-fed' })
  })
})

describe('registerTranscriptIpc — the injected remote leg', () => {
  it('wins over local resolution and feeds both channels', async () => {
    writeTranscript(lines(assistantLine('the LOCAL machine')))
    registerTranscriptIpc({ readRemote: async () => lines(assistantLine('the HOST')) })
    const res = await chat('nt-1')
    expect(res.found).toBe(true)
    expect(res.messages[0].parts[0]).toMatchObject({ text: 'the HOST' })
    expect((await search('nt-1')).map((l) => l.text)).toEqual(['the HOST'])
  })

  it('null means "not a remote session" — the local path still runs', async () => {
    writeTranscript(lines(assistantLine('local')))
    registerTranscriptIpc({ readRemote: async () => null })
    expect((await chat('nt-1')).messages[0].parts[0]).toMatchObject({ text: 'local' })
  })

  it('a remote read that came back EMPTY is not found — it is a failed read, not an empty chat', async () => {
    // The transcript resolved on the host but could not be read (master down, file deleted).
    // Reporting `found: true` here would render it as "No conversation yet." and hide the failure.
    registerTranscriptIpc({ readRemote: async () => '' })
    expect(await chat('nt-1')).toEqual({ messages: [], found: false })
  })
})

describe('registerTranscriptIpc — the chat channel is routed by AGENT', () => {
  // The ⌘M panel serves more than claude since grok joined CHAT_CAPABLE. Routing is not a
  // refinement here: claude's resolver has a cwd fallback that returns the newest CLAUDE transcript
  // for the node's directory whenever its sessionId leg misses, and a grok id always misses. So an
  // unrouted grok node is not answered with "nothing" — it is answered with SOMEONE ELSE'S
  // conversation. These tests exist to make that failure loud.
  const GROK_SID = '01a06126-b981-73f1-8b68-4547e4d7da84'

  const grokChat = (agentId?: string) =>
    f.handlers[IPC.chatReadTranscript](
      GROK_SID,
      CWD,
      undefined,
      undefined,
      agentId
    ) as Promise<ChatTranscriptResult>

  const writeGrokHistory = (body: string): string => {
    const dir = path.join(home, '.grok', 'sessions', 'proj', GROK_SID)
    fs.mkdirSync(dir, { recursive: true })
    const p = path.join(dir, 'chat_history.jsonl')
    fs.writeFileSync(p, body)
    rememberGrokSessionDir(GROK_SID, dir)
    return p
  }

  it('reads grok from its OWN file, in grok\'s own shape', async () => {
    writeGrokHistory(
      lines(
        { type: 'user', content: 'from the grok session' },
        { type: 'assistant', content: 'answered by grok' }
      )
    )
    registerTranscriptIpc()
    const res = await grokChat('grok')
    expect(res.found).toBe(true)
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(res.messages)).toContain('from the grok session')
  })

  it('does NOT hand a grok node the claude transcript sitting in the same cwd', async () => {
    // Both files exist and describe the same directory. This is the exact shape of the bug: the
    // claude one is newer and is what the cwd fallback would return.
    writeTranscript(lines(userLine('SOMEONE ELSE PRIVATE'), assistantLine('not yours')))
    writeGrokHistory(lines({ type: 'user', content: 'mine' }))
    registerTranscriptIpc()
    const res = await grokChat('grok')
    expect(JSON.stringify(res.messages)).not.toContain('SOMEONE ELSE PRIVATE')
    expect(JSON.stringify(res.messages)).toContain('mine')
  })

  it('reports not-found for a grok session no hook has located, instead of falling back', async () => {
    // No `rememberGrokSessionDir`, so the locator knows nothing. The claude transcript below is
    // present and resolvable by cwd — reaching it would be the leak.
    writeTranscript(lines(userLine('SOMEONE ELSE PRIVATE')))
    registerTranscriptIpc()
    expect(await grokChat('grok')).toEqual({ messages: [], found: false })
  })

  it('leaves the claude path exactly as it was when no agent is named', async () => {
    writeTranscript(lines(userLine('merhaba')))
    registerTranscriptIpc()
    const res = await chat()
    expect(res.found).toBe(true)
    expect(res.messages.length).toBe(1)
  })
})
