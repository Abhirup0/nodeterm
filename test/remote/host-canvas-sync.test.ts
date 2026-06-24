import { describe, it, expect } from 'vitest'
import {
  createHostCanvasSync,
  CANVAS_STATE_METHOD,
  CANVAS_MUTATE_METHOD,
  type CanvasNotifySocket
} from '../../src/main/remote/host-service'
import type { CanvasMutation, CanvasNodeState, CanvasState } from '../../src/shared/types'

function fakeNotifySocket() {
  const sent: { method: string; params: unknown }[] = []
  const socket: CanvasNotifySocket = {
    notify: (method, params) => {
      sent.push({ method, params })
      return true
    }
  }
  return { socket, sent }
}

function node(id: string): CanvasNodeState {
  return {
    id,
    kind: 'terminal',
    position: { x: 0, y: 0 },
    size: { width: 480, height: 320 },
    title: id,
    color: '#888',
    group: null
  }
}

const state = (nodes: CanvasNodeState[]): CanvasState => ({ nodes })

describe('createHostCanvasSync', () => {
  it('broadcasts the state to the client on setState', () => {
    const { socket, sent } = fakeNotifySocket()
    const sync = createHostCanvasSync(socket, () => {})

    const s = state([node('a')])
    sync.setState(s)

    expect(sent).toEqual([{ method: CANVAS_STATE_METHOD, params: s }])
  })

  it('broadcastCurrent re-sends the latest known state (and is a no-op before any)', () => {
    const { socket, sent } = fakeNotifySocket()
    const sync = createHostCanvasSync(socket, () => {})

    sync.broadcastCurrent()
    expect(sent).toHaveLength(0) // nothing known yet

    const s = state([node('a'), node('b')])
    sync.setState(s)
    sync.broadcastCurrent() // e.g. a fresh client connect

    expect(sent).toEqual([
      { method: CANVAS_STATE_METHOD, params: s },
      { method: CANVAS_STATE_METHOD, params: s }
    ])
  })

  it('routes a canvas:mutate RPC to onMutation and returns the parsed mutation', () => {
    const { socket } = fakeNotifySocket()
    const received: CanvasMutation[] = []
    const sync = createHostCanvasSync(socket, (m) => received.push(m))

    const mutation: CanvasMutation = { op: 'upsert', node: node('x') }
    const result = sync.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD, params: mutation })

    expect(result).toEqual(mutation)
    expect(received).toEqual([mutation])
  })

  it('ignores non-canvas RPC methods and malformed mutations (returns null, no callback)', () => {
    const { socket } = fakeNotifySocket()
    const received: CanvasMutation[] = []
    const sync = createHostCanvasSync(socket, (m) => received.push(m))

    expect(sync.handleRpc({ id: 'r1', method: 'pty.create', params: {} })).toBeNull()
    expect(sync.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD, params: null })).toBeNull()
    expect(sync.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD, params: { foo: 1 } })).toBeNull()
    expect(received).toHaveLength(0)
  })
})
