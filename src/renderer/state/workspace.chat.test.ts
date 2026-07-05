import { describe, it, expect } from 'vitest'
import { createChatNode, nodeStatesToFlow, flowToNodeStates } from './workspace'

describe('chat node', () => {
  it('createChatNode carries kind chat + cwd + optional session id', () => {
    const n = createChatNode(0, '/work', undefined, { chatSessionId: 'sess-1' })
    expect(n.type).toBe('chat')
    expect(n.data.cwd).toBe('/work')
    expect(n.data.chatSessionId).toBe('sess-1')
  })

  it('round-trips chat kind + chatSessionId through both serializers (resume survives restart)', () => {
    const round = nodeStatesToFlow(
      flowToNodeStates([createChatNode(0, '/work', undefined, { chatSessionId: 'sess-1' })])
    )
    const c = round.find((n) => n.type === 'chat')!
    expect(c.type).toBe('chat')
    expect(c.data.cwd).toBe('/work')
    expect(c.data.chatSessionId).toBe('sess-1')
  })

  it('does NOT persist forkFrom (one-shot bootstrap, like initialCommand)', () => {
    const round = nodeStatesToFlow(
      flowToNodeStates([createChatNode(0, '/work', undefined, { forkFrom: 'source-sess' })])
    )
    const c = round.find((n) => n.type === 'chat')!
    expect(c.data.forkFrom).toBeUndefined()
  })
})
