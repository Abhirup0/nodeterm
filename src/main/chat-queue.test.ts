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
