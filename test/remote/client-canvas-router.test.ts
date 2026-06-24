import { describe, it, expect, vi } from 'vitest'
import {
  createClientCanvasRouter,
  type CanvasMutateSocket
} from '../../src/main/remote/client-service'
import {
  CANVAS_MUTATE_METHOD,
  CANVAS_STATE_METHOD
} from '../../src/main/remote/host-service'
import type { CanvasMutation, CanvasNodeState, CanvasState } from '../../src/shared/types'

function fakeSocket() {
  const rpcs: { method: string; params: unknown }[] = []
  const socket: CanvasMutateSocket = {
    rpc: vi.fn(async (method, params) => {
      rpcs.push({ method, params })
      return {}
    })
  }
  return { socket, rpcs }
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

describe('createClientCanvasRouter', () => {
  it('returns the CanvasState for an inbound canvas:state notify (id:"")', () => {
    const { socket } = fakeSocket()
    const router = createClientCanvasRouter(socket)

    const s = state([node('a'), node('b')])
    const result = router.handleRpc({ id: '', method: CANVAS_STATE_METHOD, params: s })

    expect(result).toEqual(s)
  })

  it('ignores non-canvas methods and malformed state (returns null)', () => {
    const { socket } = fakeSocket()
    const router = createClientCanvasRouter(socket)

    expect(router.handleRpc({ id: 'r1', method: 'pty.create', params: {} })).toBeNull()
    expect(router.handleRpc({ id: '', method: CANVAS_STATE_METHOD, params: null })).toBeNull()
    expect(router.handleRpc({ id: '', method: CANVAS_STATE_METHOD, params: { foo: 1 } })).toBeNull()
    // nodes must be an array
    expect(
      router.handleRpc({ id: '', method: CANVAS_STATE_METHOD, params: { nodes: 'x' } })
    ).toBeNull()
  })

  it('sendMutation forwards the mutation to the host as a canvas:mutate RPC', () => {
    const { socket, rpcs } = fakeSocket()
    const router = createClientCanvasRouter(socket)

    const mutation: CanvasMutation = { op: 'upsert', node: node('x') }
    router.sendMutation(mutation)

    expect(rpcs).toEqual([{ method: CANVAS_MUTATE_METHOD, params: mutation }])
  })

  it('sendMutation swallows a rejected RPC (best-effort)', async () => {
    const socket: CanvasMutateSocket = { rpc: vi.fn(async () => Promise.reject(new Error('gone'))) }
    const router = createClientCanvasRouter(socket)

    expect(() => router.sendMutation({ op: 'remove', id: 'z' })).not.toThrow()
    // Let the rejected promise settle; the .catch() must absorb it (no unhandled rejection).
    await Promise.resolve()
  })
})
