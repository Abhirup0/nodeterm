/** A same-name PTY can have only one protocol generation at a time. The wire format identifies
 *  data/exit frames by session name alone, so reusing that name while the prior generation still
 *  has final frames to publish makes those frames indistinguishable from the replacement's. */
export interface RetiringSessionGeneration {
  exited: boolean
  /** Explicit kill has successfully dispatched but process exit is not observed yet. */
  retiring?: boolean
  ending: Promise<void> | null
}

/** Keep an exiting generation visible until its final output, exit frame and teardown have all
 *  completed. The identity check is defensive: the attach gate below should prevent replacement,
 *  but an unrelated future writer must never let an old cleanup delete a newer generation. */
export async function retireSessionGeneration<T>(
  sessions: Map<string, T>,
  name: string,
  generation: T,
  publishAndDispose: () => Promise<void>
): Promise<boolean> {
  await publishAndDispose()
  if (sessions.get(name) !== generation) return false
  sessions.delete(name)
  return true
}

/** Return the active generation, or an empty slot only after an exiting generation has finished
 *  publishing. Waiting rather than deleting is the protocol-compatible generation boundary: a
 *  socket may receive the old exit before its attach response, but never after it has attached to
 *  a new same-name PTY. */
export async function currentSessionAfterRetirement<T extends RetiringSessionGeneration>(
  sessions: Map<string, T>,
  name: string
): Promise<T | undefined> {
  for (;;) {
    const current = sessions.get(name)
    if (!current || (!current.exited && !current.retiring)) return current
    if (!current.ending) {
      throw new Error(`exited session ${name} has no retirement barrier`)
    }
    await current.ending
  }
}

/** Returned by a coordinated operation when the generation it inspected changed during an async
 *  step (for example, while a warm snapshot drained). The coordinator retains the same-name claim
 *  and re-enters through the retirement barrier instead of recursively racing a second claim. */
export const RETRY_SESSION_GENERATION = Symbol('retry-session-generation')

/** Serializes the entire "retire old / cancel grace / inspect or create replacement" decision for
 *  one session name. Merely awaiting `ending` is not enough: two awaiters resume from the same
 *  promise before either outer continuation can publish its replacement, so both can observe an
 *  empty map and spawn duplicate PTYs. Different names remain fully concurrent. */
export class SessionGenerationCoordinator<T extends RetiringSessionGeneration> {
  private readonly turns = new Map<string, Promise<void>>()

  constructor(
    private readonly sessions: Map<string, T>,
    private readonly onNameClaimed: () => void
  ) {}

  async run<R>(
    name: string,
    operation: (
      current: T | undefined
    ) => Promise<R | typeof RETRY_SESSION_GENERATION>
  ): Promise<R> {
    const previous = this.turns.get(name) ?? Promise.resolve()
    let release!: () => void
    const turn = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => turn)
    this.turns.set(name, tail)

    await previous
    try {
      for (;;) {
        const current = await currentSessionAfterRetirement(this.sessions, name)
        // Retirement may have just scheduled the empty-host grace timer after deleting the old
        // map entry. Cancel HERE, under the atomic name claim, immediately before inspect/create.
        this.onNameClaimed()
        const result = await operation(current)
        if (result !== RETRY_SESSION_GENERATION) return result
      }
    } finally {
      release()
      // A queued successor replaces `tail` in the map before reaching this point; never delete
      // that successor's claim while releasing ours.
      if (this.turns.get(name) === tail) this.turns.delete(name)
    }
  }
}
