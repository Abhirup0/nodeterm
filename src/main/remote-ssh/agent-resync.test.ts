import { describe, it, expect, vi } from 'vitest'
import { resyncProjectAgents, type AgentResyncDeps } from './agent-resync'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import type { SshConnection } from '@shared/ssh'

const CONN: SshConnection = { host: 'h', user: 'u' }

const assistantText = (text: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

const assistantToolUse = (id: string): string =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Bash' }] } })

function deps(over: Partial<AgentResyncDeps> = {}): AgentResyncDeps & { emitted: NormalizedAgentEvent[] } {
  const emitted: NormalizedAgentEvent[] = []
  return {
    emitted,
    workingNodes: () => [{ nodeId: 'n1', agentId: 'claude', sessionId: 's1' }],
    remoteFor: () => ({ controlPath: '/cm/p1', conn: CONN }),
    paneCommand: async () => 'claude',
    readTranscriptTail: async () => assistantText('Finished.'),
    emit: (e) => void emitted.push(e),
    ...over
  }
}

describe('resyncProjectAgents', () => {
  it('emits a rescue done for a node whose turn demonstrably ended', async () => {
    const d = deps()
    const ended = await resyncProjectAgents('/cm/p1', d)

    expect(ended).toEqual(['n1'])
    expect(d.emitted).toEqual([
      { nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'done', idle: true, sessionId: 's1' }
    ])
  })

  it('emits nothing for a node that is still working', async () => {
    const d = deps({ readTranscriptTail: async () => assistantToolUse('t1') })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('emits nothing when every probe fails — undecided leaves the node alone', async () => {
    const d = deps({
      paneCommand: async () => null,
      readTranscriptTail: async () => null
    })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('skips nodes belonging to another project', async () => {
    const d = deps({ remoteFor: () => ({ controlPath: '/cm/OTHER', conn: CONN }) })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('skips local nodes', async () => {
    const d = deps({ remoteFor: () => undefined })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('skips a node with no agentId — a synthetic event needs one to be well formed', async () => {
    const d = deps({ workingNodes: () => [{ nodeId: 'n1', sessionId: 's1' }] })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('a throwing probe is undecided, never a crash and never an ended', async () => {
    const d = deps({
      paneCommand: async () => {
        throw new Error('master died again')
      },
      readTranscriptTail: async () => {
        throw new Error('master died again')
      }
    })
    expect(await resyncProjectAgents('/cm/p1', d)).toEqual([])
    expect(d.emitted).toEqual([])
  })

  it('does not read a transcript when the pane already answered', async () => {
    const readTranscriptTail = vi.fn(async () => assistantText('x'))
    const d = deps({ paneCommand: async () => 'zsh', readTranscriptTail })

    expect(await resyncProjectAgents('/cm/p1', d)).toEqual(['n1'])
    expect(readTranscriptTail).not.toHaveBeenCalled()
  })

  it('handles several nodes independently', async () => {
    const d = deps({
      workingNodes: () => [
        { nodeId: 'done1', agentId: 'claude', sessionId: 'sa' },
        { nodeId: 'busy1', agentId: 'claude', sessionId: 'sb' }
      ],
      paneCommand: async (nodeId) => (nodeId === 'done1' ? 'zsh' : 'claude'),
      readTranscriptTail: async () => assistantToolUse('t2')
    })

    expect(await resyncProjectAgents('/cm/p1', d)).toEqual(['done1'])
    expect(d.emitted.map((e) => e.nodeId)).toEqual(['done1'])
  })
})
