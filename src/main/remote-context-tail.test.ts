import { describe, expect, it, vi } from 'vitest'
import { createRemoteContextTail } from './remote-context-tail'
import type { RemoteFileRef } from './remote-ssh/remote-file'

const ref: RemoteFileRef = { conn: { host: 'h', user: 'u' }, controlPath: '/s', path: '/abs/x.jsonl' }
const line = (used: number, model: string): string =>
  JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: used } } })

function fakeWin(): { win: never; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return { win: { isDestroyed: () => false, webContents: { send } } as never, send }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('createRemoteContextTail', () => {
  it('reads the remote transcript via readTail and pushes ContextWindowUsage on first usage', async () => {
    const { win, send } = fakeWin()
    const remoteFile = {
      readTail: vi.fn(async () => line(120, 'claude-opus-4-8')),
      readFrom: vi.fn(async (_r: RemoteFileRef, o: number) => ({ text: '', newOffset: o }))
    }
    const tail = createRemoteContextTail(win, remoteFile as never)
    tail.track('sess1', ref)
    await tick()
    expect(remoteFile.readTail).toHaveBeenCalled()
    expect(send).toHaveBeenCalled()
    const [channel, payload] = send.mock.calls.at(-1)!
    expect(channel).toBe('context:update')
    expect(payload).toMatchObject({
      sessionId: 'sess1',
      usedTokens: 120,
      model: 'claude-opus-4-8',
      windowTokens: 1_000_000
    })
    tail.untrack('sess1')
  })

  it('uses readFrom with the advancing offset after the first tail read', async () => {
    const { win } = fakeWin()
    const readFrom = vi.fn(async (_r: RemoteFileRef, o: number) => ({ text: '', newOffset: o + 0 }))
    const remoteFile = {
      readTail: vi.fn(async () => line(50, 'claude-haiku')),
      readFrom
    }
    const tail = createRemoteContextTail(win, remoteFile as never)
    tail.track('sess2', ref)
    await tick()
    expect(remoteFile.readTail).toHaveBeenCalledTimes(1)
    // pathFor exposes the tracked path
    expect(tail.pathFor('sess2')).toBe('/abs/x.jsonl')
    tail.untrack('sess2')
  })

  it('only pushes again when the usage changes', async () => {
    const { win, send } = fakeWin()
    let nextFrom = line(200, 'claude-opus-4-8')
    const remoteFile = {
      readTail: vi.fn(async () => line(100, 'claude-opus-4-8')),
      readFrom: vi.fn(async (_r: RemoteFileRef, o: number) => {
        const text = nextFrom
        nextFrom = ''
        return { text, newOffset: o + Buffer.byteLength(text) }
      })
    }
    const tail = createRemoteContextTail(win, remoteFile as never)
    tail.track('sess3', ref)
    await new Promise((r) => setTimeout(r, 1200)) // first tick (track) + one interval tick
    const usedValues = send.mock.calls.map((c) => c[1].usedTokens)
    expect(usedValues).toContain(100)
    expect(usedValues).toContain(200)
    tail.untrack('sess3')
  })
})
