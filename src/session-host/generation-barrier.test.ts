import { describe, expect, it } from 'vitest'
import {
  currentSessionAfterRetirement,
  RETRY_SESSION_GENERATION,
  retireSessionGeneration,
  SessionGenerationCoordinator,
  type RetiringSessionGeneration
} from './generation-barrier'

interface Generation extends RetiringSessionGeneration {
  subscribers: Array<(frame: string) => void>
}

describe('same-name session generation barrier', () => {
  it('publishes the old data and exit before a replacement can attach to that wire name', async () => {
    let releaseOutput!: () => void
    const outputBarrier = new Promise<void>((resolve) => {
      releaseOutput = resolve
    })
    let replacementAttached = false
    const oldFrames: string[] = []
    const replacementFrames: string[] = []
    // The same transport socket can issue the replacement attach. Because frames carry only the
    // session name, anything arriving after that attach would be interpreted as replacement data.
    const sharedSocket = (frame: string): void => {
      if (replacementAttached) replacementFrames.push(frame)
      else oldFrames.push(frame)
    }
    const old: Generation = { exited: true, ending: null, subscribers: [sharedSocket] }
    const sessions = new Map<string, Generation>([['same-name', old]])

    old.ending = retireSessionGeneration(sessions, 'same-name', old, async () => {
      await outputBarrier
      for (const subscriber of old.subscribers) subscriber('old-data')
      for (const subscriber of old.subscribers) subscriber('old-exit')
    }).then(() => {})

    const attachReplacement = (async () => {
      const active = await currentSessionAfterRetirement(sessions, 'same-name')
      expect(active).toBeUndefined()
      const replacement: Generation = {
        exited: false,
        ending: null,
        subscribers: [sharedSocket]
      }
      sessions.set('same-name', replacement)
      replacementAttached = true
      return replacement
    })()

    await Promise.resolve()
    const attachedBeforeOutputRelease = replacementAttached
    const generationBeforeOutputRelease = sessions.get('same-name')

    releaseOutput()
    const replacement = await attachReplacement

    expect(replacementFrames).toEqual([])
    expect(oldFrames).toEqual(['old-data', 'old-exit'])
    expect(attachedBeforeOutputRelease).toBe(false)
    expect(generationBeforeOutputRelease).toBe(old)
    expect(sessions.get('same-name')).toBe(replacement)
  })

  it('atomically gives two retirement waiters one cold replacement and one warm generation', async () => {
    let releaseRetirement!: () => void
    const retirementBarrier = new Promise<void>((resolve) => {
      releaseRetirement = resolve
    })
    const old: Generation = { exited: true, ending: null, subscribers: [] }
    const sessions = new Map<string, Generation>([['same-name', old]])
    old.ending = retireSessionGeneration(sessions, 'same-name', old, async () => {
      await retirementBarrier
    }).then(() => {})
    const coordinator = new SessionGenerationCoordinator(sessions, () => {})
    let creates = 0

    const attach = () =>
      coordinator.run('same-name', async (current) => {
        if (current) return { fresh: false, session: current }
        creates++
        const replacement: Generation = { exited: false, ending: null, subscribers: [] }
        sessions.set('same-name', replacement)
        return { fresh: true, session: replacement }
      })

    const first = attach()
    const second = attach()
    await Promise.resolve()
    releaseRetirement()
    const results = await Promise.all([first, second])

    expect(creates).toBe(1)
    expect(results.map((result) => result.fresh).sort()).toEqual([false, true])
    expect(results[0].session).toBe(results[1].session)
    expect(sessions.get('same-name')).toBe(results[0].session)
  })

  it('cancels a grace timer scheduled by retirement before publishing the replacement', async () => {
    let releaseRetirement!: () => void
    const retirementBarrier = new Promise<void>((resolve) => {
      releaseRetirement = resolve
    })
    const old: Generation = { exited: true, ending: null, subscribers: [] }
    const sessions = new Map<string, Generation>([['same-name', old]])
    let graceTimerArmed = false
    old.ending = retireSessionGeneration(sessions, 'same-name', old, async () => {
      await retirementBarrier
    }).then((released) => {
      if (released) graceTimerArmed = true
    })
    const coordinator = new SessionGenerationCoordinator(sessions, () => {
      graceTimerArmed = false
    })

    const attach = coordinator.run('same-name', async (current) => {
      expect(current).toBeUndefined()
      const replacement: Generation = { exited: false, ending: null, subscribers: [] }
      sessions.set('same-name', replacement)
      return replacement
    })

    await Promise.resolve()
    releaseRetirement()
    const replacement = await attach

    expect(sessions.get('same-name')).toBe(replacement)
    expect(graceTimerArmed).toBe(false)
  })

  it('retries within the same atomic claim when an inspected generation retires', async () => {
    const active: Generation = { exited: false, ending: null, subscribers: [] }
    const sessions = new Map<string, Generation>([['same-name', active]])
    const coordinator = new SessionGenerationCoordinator(sessions, () => {})
    let operations = 0

    const result = await coordinator.run('same-name', async (current) => {
      operations++
      if (current === active) {
        active.exited = true
        active.ending = retireSessionGeneration(sessions, 'same-name', active, async () => {}).then(
          () => {}
        )
        return RETRY_SESSION_GENERATION
      }
      return 'replacement-slot'
    })

    expect(result).toBe('replacement-slot')
    expect(operations).toBe(2)
  })
})
