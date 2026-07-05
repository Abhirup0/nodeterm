// Pure helpers for the chat driver: a push-based AsyncIterable (the SDK's streaming
// prompt input) and the driver-side FIFO of messages typed while a turn is running.
import type { ChatQueueItem } from '../shared/types'

export function createPushIterable<T>(): { iterable: AsyncIterable<T>; push(item: T): void; end(): void } {
  const buffer: T[] = []
  let notify: (() => void) | null = null
  let ended = false
  const wake = () => { notify?.(); notify = null }
  return {
    push(item: T) { buffer.push(item); wake() },
    end() { ended = true; wake() },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (buffer.length) yield buffer.shift() as T
          if (ended) return
          await new Promise<void>((r) => { notify = r })
        }
      }
    }
  }
}

export class ChatInputQueue {
  private list: ChatQueueItem[] = []
  private seq = 0
  items(): ChatQueueItem[] { return [...this.list] }
  add(text: string): ChatQueueItem {
    const item = { id: `q-${++this.seq}`, text }
    this.list.push(item)
    return item
  }
  remove(id: string): boolean {
    const before = this.list.length
    this.list = this.list.filter((i) => i.id !== id)
    return this.list.length < before
  }
  takeNext(): ChatQueueItem | undefined { return this.list.shift() }
}
