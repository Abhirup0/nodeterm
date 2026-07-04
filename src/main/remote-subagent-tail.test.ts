import { describe, expect, it, vi } from 'vitest'
import { createRemoteSubagentTail } from './remote-subagent-tail'
import { formatSubagentChunk } from './subagent-tail'
import type { RemoteFileRef } from './remote-ssh/remote-file'

const ref: RemoteFileRef = { conn: { host: 'h', user: 'u' }, controlPath: '/s', path: '/abs/agent-1.jsonl' }

function fakeWin(): { win: never; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn()
  return { win: { isDestroyed: () => false, webContents: { send } } as never, send }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

const assistant = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

describe('createRemoteSubagentTail', () => {
  it('streams a formatted chunk over agent:subagent-activity for the toolUseId', async () => {
    const { win, send } = fakeWin()
    const raw = assistant('hello from subagent')
    let served = false
    const remoteFile = {
      readFrom: vi.fn(async (_r: RemoteFileRef, o: number) => {
        if (served) return { text: '', newOffset: o }
        served = true
        return { text: raw + '\n', newOffset: o + Buffer.byteLength(raw + '\n') }
      })
    }
    const tail = createRemoteSubagentTail(win, remoteFile as never)
    tail.track('tool-1', ref)
    await tick()
    expect(send).toHaveBeenCalled()
    const [channel, payload] = send.mock.calls.at(-1)!
    expect(channel).toBe('agent:subagent-activity')
    expect(payload.toolUseId).toBe('tool-1')
    expect(payload.chunk).toContain(formatSubagentChunk(raw + '\n'))
    tail.untrack('tool-1')
  })

  it('does not drop a line served torn across two reads', async () => {
    const { win, send } = fakeWin()
    const raw = assistant('remote torn line')
    // The remote `tail -c +N` can return a line mid-write; the second read completes it.
    const parts = [raw.slice(0, 15), raw.slice(15) + '\n']
    let i = 0
    const remoteFile = {
      readFrom: vi.fn(async (_r: RemoteFileRef, o: number) => {
        const text = parts[i] ?? ''
        i++
        return { text, newOffset: o + Buffer.byteLength(text) }
      })
    }
    const tail = createRemoteSubagentTail(win, remoteFile as never)
    tail.track('tool-3', ref) // immediate first read gets the partial line
    await new Promise((r) => setTimeout(r, 1100)) // next poll (1s) reads the rest
    const streamed = send.mock.calls.map((c) => (c[1] as { chunk: string }).chunk).join('')
    expect(streamed).toContain('remote torn line')
    tail.untrack('tool-3')
  }, 5000)

  it('does not send when the chunk is empty', async () => {
    const { win, send } = fakeWin()
    const remoteFile = {
      readFrom: vi.fn(async (_r: RemoteFileRef, o: number) => ({ text: '', newOffset: o }))
    }
    const tail = createRemoteSubagentTail(win, remoteFile as never)
    tail.track('tool-2', ref)
    await tick()
    expect(send).not.toHaveBeenCalled()
    tail.untrack('tool-2')
  })
})
