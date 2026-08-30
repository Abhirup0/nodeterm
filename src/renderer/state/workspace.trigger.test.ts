import { describe, expect, it } from 'vitest'
import type { CanvasNodeState } from '@shared/types'
import type { TriggerSpec } from '@shared/trigger'
import { flowToNodeStates, nodeStatesToFlow } from './workspace'

const spec = (): TriggerSpec => ({
  schedule: { kind: 'interval', everyMinutes: 30 },
  payload: 'npm test',
  target: 'term-tgt-1'
})

const state = (): CanvasNodeState => ({
  id: 'trigger-a-1',
  kind: 'trigger',
  position: { x: 5, y: 6 },
  size: { width: 300, height: 170 },
  title: 'Every 30m',
  color: '#888',
  group: null,
  trigger: spec()
})

describe('trigger node serialization', () => {
  it('nodeStatesToFlow carries the spec into node data', () => {
    const [flow] = nodeStatesToFlow([state()])
    expect(flow.type).toBe('trigger')
    expect(flow.data.trigger).toEqual(spec())
  })

  it('round-trips through flowToNodeStates without loss', () => {
    const [back] = flowToNodeStates(nodeStatesToFlow([state()]))
    expect(back.kind).toBe('trigger')
    expect(back.trigger).toEqual(spec())
    expect(back.id).toBe('trigger-a-1')
  })
})
