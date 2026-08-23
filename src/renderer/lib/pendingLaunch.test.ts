import { describe, it, expect } from 'vitest'
import { dependencyEdges, launchesToFire, unmetDeps, type ArmedNode, type StatusById } from './pendingLaunch'

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
