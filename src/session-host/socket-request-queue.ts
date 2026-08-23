/** Preserve wire order for commands targeting the same session on one socket. Dispatch itself is
 * asynchronous (warm snapshots and geometry barriers await), so merely iterating parsed frames in
 * order lets a later detach run before the earlier attach has even prepared its claim. Different
 * names keep independent lanes and therefore retain the protocol's intended concurrency. */
export class SessionHostSocketRequestQueue {
  private readonly tails = new Map<string, Promise<void>>()

  enqueue(name: string, task: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(name) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(task)
    this.tails.set(name, current)
    void current.then(
      () => this.release(name, current),
      () => this.release(name, current)
    )
    return current
  }

  private release(name: string, current: Promise<void>): void {
    if (this.tails.get(name) === current) this.tails.delete(name)
  }
}
