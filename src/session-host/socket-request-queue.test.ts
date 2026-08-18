import { describe, expect, it, vi } from 'vitest'
import { SessionHostSocketRequestQueue } from './socket-request-queue'

describe('session-host per-socket request ordering', () => {
  it('does not let a same-name detach overtake a delayed attach', async () => {
    const queue = new SessionHostSocketRequestQueue()
    const order: string[] = []
    let releaseAttach!: () => void
    const attach = queue.enqueue(
      'same-name',
      () =>
        new Promise<void>((resolve) => {
          order.push('attach-start')
          releaseAttach = () => {
            order.push('attach-finish')
            resolve()
          }
        })
    )
    const detachTask = vi.fn(async () => {
      order.push('detach')
    })
    const detach = queue.enqueue('same-name', detachTask)

    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['attach-start'])
    expect(detachTask).not.toHaveBeenCalled()
    releaseAttach()
    await Promise.all([attach, detach])
    expect(order).toEqual(['attach-start', 'attach-finish', 'detach'])
  })

  it('keeps different session names concurrent', async () => {
    const queue = new SessionHostSocketRequestQueue()
    let releaseFirst!: () => void
    const first = queue.enqueue(
      'first',
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
    )
    const second = vi.fn(async () => {})

    await queue.enqueue('second', second)
    expect(second).toHaveBeenCalledOnce()
    releaseFirst()
    await first
  })
})
