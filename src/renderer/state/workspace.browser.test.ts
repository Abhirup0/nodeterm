import { describe, it, expect } from 'vitest'
import { createBrowserNode, nodeStatesToFlow, flowToNodeStates } from './workspace'

describe('browser node', () => {
  it('createBrowserNode carries kind browser + url', () => {
    const n = createBrowserNode(0, 'https://example.com')
    expect(n.type).toBe('browser')
    expect(n.data.url).toBe('https://example.com')
  })

  it('round-trips browser kind + url through both serializers', () => {
    const round = nodeStatesToFlow(flowToNodeStates([createBrowserNode(0, 'https://a.dev')]))
    const b = round.find((n) => n.type === 'browser')!
    expect(b.data.url).toBe('https://a.dev')
  })

  it('createBrowserNode without a partition is the USER-opened node — unchanged, default session', () => {
    expect(createBrowserNode(0, 'https://x.test/').data.partition).toBeUndefined()
  })

  it('an agent-opened node carries its partition, set once at creation', () => {
    const n = createBrowserNode(0, 'https://x.test/', undefined, 'persist:nt-agent-browser-p1')
    expect(n.data.partition).toBe('persist:nt-agent-browser-p1')
  })

  it("an agent node's partition survives the persistence round-trip; a user node's stays absent", () => {
    // The jar must outlive a reopen, or the agent is logged out on the next app start.
    const agent = createBrowserNode(0, 'https://a.dev', undefined, 'persist:nt-agent-browser-p1')
    const user = createBrowserNode(1, 'https://b.dev')
    const round = nodeStatesToFlow(flowToNodeStates([agent, user]))
    expect(round.find((n) => n.id === agent.id)!.data.partition).toBe('persist:nt-agent-browser-p1')
    expect(round.find((n) => n.id === user.id)!.data.partition).toBeUndefined()
  })
})
