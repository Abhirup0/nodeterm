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
})
