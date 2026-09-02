import { describe, it, expect } from 'vitest'
import {
  dependencyEdges,
  launchesToFire,
  launchRetryDelay,
  launchTooltip,
  unmetDeps,
  LAUNCH_DELIVERY_ATTEMPTS,
  LAUNCH_STALL_MS,
  type ArmedNode,
  type StatusById
} from './pendingLaunch'

const armed = (id: string, after: string[], command = `echo ${id}`): ArmedNode => ({
  id,
  data: { pendingLaunch: { after, command } }
})
const plain = (id: string): ArmedNode => ({ id, data: {} })

describe('launchesToFire', () => {
  const live = new Set(['a', 'b', 'c'])

  it('fires when every dep has reported done', () => {
    const status: StatusById = { a: { state: 'done' }, b: { state: 'done' } }
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('does NOT fire while a dep is still working', () => {
    const status: StatusById = { a: { state: 'done' }, b: { state: 'working' } }
    expect(launchesToFire([armed('c', ['a', 'b'])], status, live)).toEqual([])
  })

  it('does NOT fire on an unknown state — "no news" is not "finished"', () => {
    // The whole point: right after a fan-out the upstream stations have emitted nothing yet.
    expect(launchesToFire([armed('c', ['a'])], {}, live)).toEqual([])
  })

  it('treats waiting/blocked as not satisfied — the station still needs its user', () => {
    expect(launchesToFire([armed('c', ['a'])], { a: { state: 'waiting' } }, live)).toEqual([])
    expect(launchesToFire([armed('c', ['a'])], { a: { state: 'blocked' } }, live)).toEqual([])
  })

  it('treats a dep that is no longer on the canvas as satisfied', () => {
    // A deleted node can never report; waiting on it would strand the dependent forever.
    const status: StatusById = { a: { state: 'done' } }
    expect(launchesToFire([armed('c', ['a', 'ghost'])], status, new Set(['a', 'c']))).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('ignores nodes that are not armed, and armed nodes with an empty command', () => {
    const status: StatusById = { a: { state: 'done' } }
    expect(launchesToFire([plain('c'), armed('d', ['a'], '')], status, live)).toEqual([])
  })

  it('fires immediately when there are no deps left to wait on', () => {
    expect(launchesToFire([armed('c', [])], {}, live)).toEqual([{ id: 'c', command: 'echo c' }])
  })

  it('walks a chain A → B → C one station at a time', () => {
    const chain = [armed('b', ['a']), armed('c', ['b'])]
    // Nothing has reported: nothing fires.
    expect(launchesToFire(chain, {}, live)).toEqual([])
    // A done releases B only — C waits on B, which has not even started.
    expect(launchesToFire(chain, { a: { state: 'done' } }, live)).toEqual([{ id: 'b', command: 'echo b' }])
    // B running is still not B done.
    expect(launchesToFire(chain, { a: { state: 'done' }, b: { state: 'working' } }, live)).toEqual([
      { id: 'b', command: 'echo b' }
    ])
    // B done releases C. (B is still listed here because the caller, not this function, retires a
    // delivered launch by clearing its pendingLaunch — exactly-once lives in `launchInFlight`.)
    expect(launchesToFire(chain, { a: { state: 'done' }, b: { state: 'done' } }, live)).toEqual([
      { id: 'b', command: 'echo b' },
      { id: 'c', command: 'echo c' }
    ])
  })

  it('after a restart (empty status map) a persisted arming holds — nothing will report, ▶ is the escape', () => {
    // Agent state is transient; a live dep that reported `done` before the restart is unknown now,
    // and unknown is NOT satisfied. The manual run-now on the badge exists for exactly this.
    expect(launchesToFire([armed('c', ['a'])], {}, live)).toEqual([])
    expect(unmetDeps(armed('c', ['a']), {}, live)).toEqual(['a'])
  })

  it('a dep deleted mid-chain releases what waited on it, but not what waits further down', () => {
    const chain = [armed('b', ['a']), armed('c', ['b'])]
    const liveWithoutA = new Set(['b', 'c'])
    expect(launchesToFire(chain, {}, liveWithoutA)).toEqual([{ id: 'b', command: 'echo b' }])
  })
})

describe('launchesToFire — awaitSetupGroup (a worktree whose setup script must land first)', () => {
  const live = new Set(['a', 'c'])
  const armedForSetup = (id: string, groupId: string, after: string[] = []): ArmedNode => ({
    id,
    data: { pendingLaunch: { after, command: `echo ${id}`, awaitSetupGroup: groupId } }
  })

  it('holds the launch while the group’s setup run is not done', () => {
    expect(launchesToFire([armedForSetup('c', 'g1')], {}, live, () => false)).toEqual([])
  })

  it('fires once the group’s setup run is done', () => {
    expect(launchesToFire([armedForSetup('c', 'g1')], {}, live, () => true)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('with no setupDone probe at all, the gate is open — an absent probe never strands a node', () => {
    // Reached after an app restart: the run store is empty, and a node armed before the restart
    // would otherwise wait forever for a run nobody is going to report on again.
    expect(launchesToFire([armedForSetup('c', 'g1')], {}, live)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('asks the probe about THIS node’s group', () => {
    const asked: string[] = []
    launchesToFire([armedForSetup('c', 'g-seven')], {}, live, (g) => {
      asked.push(g)
      return true
    })
    expect(asked).toEqual(['g-seven'])
  })

  it('needs BOTH gates: setup done AND every `after` dep satisfied', () => {
    const node = [armedForSetup('c', 'g1', ['a'])]
    // setup done, dep still working
    expect(launchesToFire(node, { a: { state: 'working' } }, live, () => true)).toEqual([])
    // dep done, setup still running
    expect(launchesToFire(node, { a: { state: 'done' } }, live, () => false)).toEqual([])
    // both
    expect(launchesToFire(node, { a: { state: 'done' } }, live, () => true)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })

  it('leaves a node with no awaitSetupGroup alone even while some setup is running', () => {
    expect(launchesToFire([armed('c', [])], {}, live, () => false)).toEqual([
      { id: 'c', command: 'echo c' }
    ])
  })
})

describe('unmetDeps', () => {
  it('reports only the deps still outstanding', () => {
    const live = new Set(['a', 'b', 'c'])
    const status: StatusById = { a: { state: 'done' }, b: { state: 'working' } }
    expect(unmetDeps(armed('c', ['a', 'b']), status, live)).toEqual(['b'])
  })

  it('is empty for a node that is not armed', () => {
    expect(unmetDeps(plain('c'), {}, new Set(['c']))).toEqual([])
  })
})

describe('dependencyEdges', () => {
  it('draws one edge per live dep, pointing dep → dependent', () => {
    expect(dependencyEdges([armed('c', ['a', 'b'])], new Set(['a', 'b', 'c']))).toEqual([
      { id: 'dep-a-c', source: 'a', target: 'c' },
      { id: 'dep-b-c', source: 'b', target: 'c' }
    ])
  })

  it('draws nothing for a dep that is gone', () => {
    expect(dependencyEdges([armed('c', ['ghost'])], new Set(['c']))).toEqual([])
  })

  it('draws nothing once the node is no longer armed', () => {
    expect(dependencyEdges([plain('c')], new Set(['c']))).toEqual([])
  })
})

/**
 * Issue #569 item 1 — the delivery policy behind an armed node's held launch.
 *
 * The bug these pin: delivery used to be a flat 5 × 400 ms = 2 s budget started when the CANVAS
 * decided a node was ready to launch, not when the node's terminal existed. A cold project switch
 * spends that budget on loading the canvas, mounting the node and spawning tmux, so the launch was
 * abandoned before there was anything to deliver into — and abandoned into a `console.warn`, which
 * left a node reading QUEUED forever with no way to tell it apart from one still waiting on a
 * dependency.
 */
describe('launch delivery policy (#569 item 1)', () => {
  it('the schedule backs off and is bounded — exhaustion is reachable, so "gave up" can be told', () => {
    const delays: number[] = []
    for (let attempt = 1; ; attempt++) {
      const d = launchRetryDelay(attempt)
      if (d === null) break
      delays.push(d)
      expect(attempt).toBeLessThan(20) // guard: a schedule that never ends is the bug, not a fix
    }
    expect(delays.length).toBe(LAUNCH_DELIVERY_ATTEMPTS)
    // Strictly increasing: a flat schedule is what made the old budget a fixed 2 s wall.
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThan(delays[i - 1])
    // And the whole window is comfortably wider than the old one, measured from READINESS.
    expect(delays.reduce((a, b) => a + b, 0)).toBeGreaterThan(10_000)
  })

  it('an attempt past the end has no delay — nothing silently retries forever', () => {
    expect(launchRetryDelay(LAUNCH_DELIVERY_ATTEMPTS)).not.toBeNull()
    expect(launchRetryDelay(LAUNCH_DELIVERY_ATTEMPTS + 1)).toBeNull()
  })

  it('the stall warning waits longer than a cold project switch could plausibly take', () => {
    expect(LAUNCH_STALL_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('launchTooltip — the QUEUED badge never goes silent (#569 item 1)', () => {
  const cmd = 'claude "review the diff"'

  it('with nothing to report it names the dependencies, exactly as before', () => {
    const t = launchTooltip(undefined, 'Builder, Tests', cmd)
    expect(t).toContain('Waiting for Builder, Tests to finish')
    expect(t).toContain(cmd)
    expect(t).not.toContain('▶')
  })

  it('a stalled launch says it is still held, and does NOT claim a cause it never measured', () => {
    const t = launchTooltip({ kind: 'stalled', since: 1 }, 'Builder', cmd)
    expect(t).toContain('has not started yet')
    expect(t).toContain('still held')
    expect(t).toContain('▶')
    // We know the terminal is not up; we do not know why. Naming a cause here would be the
    // misleading-error failure this feature exists to avoid.
    expect(t.toLowerCase()).not.toMatch(/ssh|host is down|crash/)
  })

  it('a failed launch reports the attempt count and that nothing will retry it', () => {
    const t = launchTooltip({ kind: 'failed', attempts: 5, at: 1 }, 'Builder', cmd)
    expect(t).toContain('5 attempts')
    expect(t).toContain('nothing will retry it')
    expect(t).toContain('▶')
    expect(t).toContain(cmd)
  })

  it('singularises one attempt (the manual ▶ reports exactly one refusal)', () => {
    expect(launchTooltip({ kind: 'failed', attempts: 1, at: 1 }, 'Builder', cmd)).toContain(
      '1 attempt was refused'
    )
  })

  it('failed outranks the dependency sentence — the warning is never buried', () => {
    const t = launchTooltip({ kind: 'failed', attempts: 5, at: 1 }, 'Builder', cmd)
    expect(t).not.toContain('Waiting for Builder')
  })
})
