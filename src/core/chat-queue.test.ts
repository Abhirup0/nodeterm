import { describe, expect, it } from 'vitest'
import { ChatInputQueue, createPushIterable } from './chat-queue'

describe('createPushIterable', () => {
  it('yields pushed items in order and finishes on end()', async () => {
    const { iterable, push, end } = createPushIterable<number>()
    push(1); push(2)
    const seen: number[] = []
    const done = (async () => { for await (const v of iterable) seen.push(v) })()
    // push after consumption started, then close
    push(3); end()
    await done
    expect(seen).toEqual([1, 2, 3])
  })

  it('parks a consumer on an empty iterable and wakes it when a value is pushed', async () => {
    const { iterable, push, end } = createPushIterable<number>()
    const seen: number[] = []
    // Start consuming an EMPTY iterable — the loop parks on the internal notify promise.
    const done = (async () => { for await (const v of iterable) seen.push(v) })()
    // Let the microtask/timer queue drain so the consumer is actually parked.
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([])
    // Now push: this must wake the parked consumer and deliver the value.
    push(42)
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toEqual([42])
    end()
    await done
    expect(seen).toEqual([42])
  })

  it('drops items pushed after end()', async () => {
    const { iterable, push, end } = createPushIterable<number>()
    push(1); end()
    // push-after-end is ignored — nothing new is delivered.
    push(2)
    const seen: number[] = []
    for await (const v of iterable) seen.push(v)
    expect(seen).toEqual([1])
  })
})

describe('ChatInputQueue', () => {
  it('is FIFO with stable ids and removal', () => {
    const q = new ChatInputQueue()
    const a = q.add('first'); const b = q.add('second')
    expect(q.items().map((i) => i.text)).toEqual(['first', 'second'])
    expect(q.remove(a.id)).toBe(true)
    expect(q.takeNext()).toEqual(b)
    expect(q.takeNext()).toBeUndefined()
  })
})
