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
