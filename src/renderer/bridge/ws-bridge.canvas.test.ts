import { describe, it, expect } from 'vitest'
import { buildCanvasApi } from './ws-bridge'
import { IPC } from '../../shared/ipc'
import type { CanvasMutation } from '../../shared/types'

function fakeClient() {
  const casts: Array<{ method: string; args: unknown[] }> = []
  const subs = new Map<string, Set<(...a: unknown[]) => void>>()
  return {
    casts,
    subs,
    /** Deliver a server `ev` frame on a channel, as RpcClient's onMessage would. */
    emit: (channel: string, ...args: unknown[]) => subs.get(channel)?.forEach((fn) => fn(...args)),
    cast: (method: string, ...args: unknown[]) => casts.push({ method, args }),
    subscribe: (channel: string, fn: (...a: unknown[]) => void) => {
      const set = subs.get(channel) ?? new Set()
      set.add(fn)
      subs.set(channel, set)
      return () => set.delete(fn)
    }
  }
}

describe('buildCanvasApi', () => {
  it('mutate casts canvas:mut and onMutation subscribes to it', () => {
    const c = fakeClient()
    const { canvas } = buildCanvasApi(c as never)
    const seen: Array<[string, CanvasMutation]> = []
    const off = canvas.onMutation((projectId, m) => seen.push([projectId, m]))

    canvas.mutate('p1', { op: 'remove', id: 'n1' })
    expect(c.casts).toEqual([
      { method: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'n1' }] }
    ])

    // A PEER's mutation arrives on the same channel (the reflector never echoes our own back).
    c.emit(IPC.canvasMut, 'p1', { op: 'remove', id: 'n2' })
    expect(seen).toEqual([['p1', { op: 'remove', id: 'n2' }]])

    off()
    c.emit(IPC.canvasMut, 'p1', { op: 'remove', id: 'n3' })
    expect(seen).toHaveLength(1)
  })
})
