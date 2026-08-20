// @vitest-environment jsdom
//
// The renderer's view of a setup/archive run. Everything here exists because of two properties of
// the wire:
//
//  - it is LOSSY AND RE-ORDERABLE. `ProjectSetupEvent.seq` is monotonic per run precisely so a
//    client can tell a duplicate (relay re-delivery) from a fresh chunk.
//  - `runKey` IS NOT UNIQUE OVER TIME. It is the deterministic single-flight key (kind + location),
//    so two sequential runs of the same script share it and each restart `seq` at 1. `runId` is the
//    per-launch identity; folding on it is what keeps run 2 from being swallowed as run 1's stale
//    tail.
//
// And because an event carries no lane discriminator, storage is keyed by `runKey` alone: the
// initiator ATTACHES its run to a project (or a worktree group) at ack time, and the selectors
// resolve through those attachments.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ProjectSetupEvent } from '@shared/project-settings'
import {
  SETUP_TAIL_MAX,
  setupAckDecision,
  setupGateDone,
  useProjectSetup,
  type SetupRunState
} from './projectSetup'

const ev = (over: Partial<ProjectSetupEvent> = {}): ProjectSetupEvent => ({
  runKey: 'rk',
  runId: 'run-a',
  kind: 'setup',
  seq: 1,
  state: 'running',
  ...over
})

const apply = (e: ProjectSetupEvent): void => useProjectSetup.getState().applyEvent(e)
const attachProject = (projectId: string, runKey: string): void =>
  useProjectSetup.getState().attachProject(projectId, runKey)
const runForProject = (projectId: string): ReturnType<typeof useProjectSetup.getState>['byRunKey'][string] =>
  useProjectSetup.getState().runForProject(projectId)

beforeEach(() => {
  useProjectSetup.setState({ byRunKey: {}, projectRunKey: {}, groupRunKey: {}, pendingByGroup: {} })
})

describe('useProjectSetup — folding the event stream', () => {
  it('opens a run entry from the first event and appends chunks in seq order', () => {
    apply(ev({ seq: 1, chunk: 'installing…\n' }))
    apply(ev({ seq: 2, chunk: 'done\n' }))
    const run = useProjectSetup.getState().byRunKey.rk!
    expect(run.runKey).toBe('rk')
    expect(run.runId).toBe('run-a')
    expect(run.kind).toBe('setup')
    expect(run.state).toBe('running')
    expect(run.tail).toBe('installing…\ndone\n')
  })

  it('drops a DUPLICATE seq — a re-delivered event must not double the output', () => {
    apply(ev({ seq: 1, chunk: 'a' }))
    apply(ev({ seq: 2, chunk: 'b' }))
    apply(ev({ seq: 2, chunk: 'b' }))
    expect(useProjectSetup.getState().byRunKey.rk!.tail).toBe('ab')
  })

  it('drops a STALE seq that arrives after a newer one', () => {
    apply(ev({ seq: 1, chunk: 'a' }))
    apply(ev({ seq: 3, chunk: 'c' }))
    // seq 2 lost the race; re-inserting it here would put the output out of order AND would let a
    // stale `running` overwrite a terminal state.
    apply(ev({ seq: 2, chunk: 'b', state: 'done', exitCode: 0 }))
    const run = useProjectSetup.getState().byRunKey.rk!
    expect(run.tail).toBe('ac')
    expect(run.state).toBe('running')
    expect(run.exitCode).toBeUndefined()
  })

  it('caps the tail at 8 KB, keeping the END (the failure is at the bottom, not the top)', () => {
    apply(ev({ seq: 1, chunk: 'x'.repeat(SETUP_TAIL_MAX) }))
    apply(ev({ seq: 2, chunk: 'TAIL' }))
    const { tail } = useProjectSetup.getState().byRunKey.rk!
    expect(tail.length).toBe(SETUP_TAIL_MAX)
    expect(tail.endsWith('TAIL')).toBe(true)
    expect(tail.startsWith('x')).toBe(true)
  })

  it('caps a single over-long chunk too', () => {
    apply(ev({ seq: 1, chunk: 'y'.repeat(SETUP_TAIL_MAX * 3) }))
    expect(useProjectSetup.getState().byRunKey.rk!.tail.length).toBe(SETUP_TAIL_MAX)
  })

  it('records the terminal state and exit code', () => {
    apply(ev({ seq: 1, chunk: 'boom\n' }))
    apply(ev({ seq: 2, state: 'failed', exitCode: 2 }))
    const run = useProjectSetup.getState().byRunKey.rk!
    expect(run.state).toBe('failed')
    expect(run.exitCode).toBe(2)
    expect(run.tail).toBe('boom\n')
  })

  it('a NEW runKey is its own entry — one project’s setup and archive never share a slot', () => {
    apply(ev({ seq: 1, chunk: 'setup output\n' }))
    apply(ev({ runKey: 'rk-archive', runId: 'run-b', kind: 'archive', seq: 1, chunk: 'archive output\n' }))
    expect(useProjectSetup.getState().byRunKey.rk!.tail).toBe('setup output\n')
    expect(useProjectSetup.getState().byRunKey['rk-archive']!.tail).toBe('archive output\n')
  })

  it('C1: a SECOND run under the SAME runKey (new runId) starts fresh — seq restarting at 1 is not stale', () => {
    apply(ev({ seq: 1, chunk: 'first run\n' }))
    apply(ev({ seq: 2, state: 'failed', exitCode: 1 }))
    // The user hits Run again. Same script, same location ⇒ the SAME deterministic runKey, and the
    // service's seq counter starts over. Folding on runKey+seq alone would drop every one of these
    // as stale and leave the failed badge standing over a live run.
    apply(ev({ runId: 'run-b', seq: 1, chunk: 'second run\n' }))
    const run = useProjectSetup.getState().byRunKey.rk!
    expect(run.runId).toBe('run-b')
    expect(run.state).toBe('running')
    expect(run.tail).toBe('second run\n')
    expect(run.exitCode).toBeUndefined()
    expect(run.seq).toBe(1)
  })

  it('and the fresh entry then dedupes on its OWN seq', () => {
    apply(ev({ seq: 1, chunk: 'first\n' }))
    apply(ev({ runId: 'run-b', seq: 1, chunk: 'second\n' }))
    apply(ev({ runId: 'run-b', seq: 1, chunk: 'second\n' }))
    expect(useProjectSetup.getState().byRunKey.rk!.tail).toBe('second\n')
  })
})

describe('useProjectSetup — lane attachment', () => {
  it('records an event for a runKey nobody has attached yet', () => {
    // The ack and the first event race; the attachment may land a tick later, and the head of the
    // output must survive that.
    apply(ev({ seq: 1, chunk: 'early\n' }))
    expect(runForProject('p1')).toBeUndefined()
    attachProject('p1', 'rk')
    expect(runForProject('p1')!.tail).toBe('early\n')
  })

  it('does NOT surface an unattached run in a project’s lane', () => {
    apply(ev({ runKey: 'someone-elses', runId: 'run-z', seq: 1, chunk: 'not mine\n' }))
    attachProject('p1', 'rk')
    expect(runForProject('p1')).toBeUndefined()
  })

  it('routes a worktree run through attachGroup, independently of the project lane', () => {
    attachProject('p1', 'rk')
    useProjectSetup.getState().attachGroup('g1', 'rk-worktree')
    apply(ev({ seq: 1, chunk: 'project\n' }))
    apply(ev({ runKey: 'rk-worktree', runId: 'run-w', seq: 1, chunk: 'worktree\n' }))
    expect(runForProject('p1')!.tail).toBe('project\n')
    expect(useProjectSetup.getState().runForGroup('g1')!.tail).toBe('worktree\n')
  })

  it('a group lane follows its run through running → done (what the frame’s chip reads)', () => {
    useProjectSetup.getState().attachGroup('g1', 'rk')
    apply(ev({ seq: 1, chunk: 'npm ci\n' }))
    expect(useProjectSetup.getState().runForGroup('g1')!.state).toBe('running')
    apply(ev({ seq: 2, state: 'done', exitCode: 0 }))
    const run = useProjectSetup.getState().runForGroup('g1')!
    expect(run.state).toBe('done')
    expect(run.exitCode).toBe(0)
    // …and a FAILED archive run attached later replaces it, so the chip reports the newer one.
    useProjectSetup.getState().attachGroup('g1', 'rk-archive')
    apply(ev({ runKey: 'rk-archive', runId: 'run-c', kind: 'archive', seq: 1, state: 'failed', exitCode: 3 }))
    expect(useProjectSetup.getState().runForGroup('g1')!.kind).toBe('archive')
    expect(useProjectSetup.getState().runForGroup('g1')!.state).toBe('failed')
  })

  it('RECOVERY: re-running setup for the same GROUP re-attaches its lane and opens the gate again', () => {
    // The frame's chip is the only re-run affordance that can do this: the settings panel's own Run
    // executes at the project ROOT and attaches the PROJECT lane, so it can never clear a worktree
    // group's failed run — the group would stay `failed` forever and its armed nodes with it.
    useProjectSetup.getState().attachGroup('g1', 'rk')
    apply(ev({ seq: 1, state: 'failed', exitCode: 1, chunk: 'npm ci exploded\n' }))
    expect(setupGateDone(useProjectSetup.getState().runForGroup('g1'), false)).toBe(false)
    // Chip clicked → a fresh launch for the SAME worktree. Deterministic runKey, so the ack hands
    // back the same key; the fresh `runId` is what makes it a new run rather than a stale tail.
    useProjectSetup.getState().attachGroup('g1', 'rk')
    apply(ev({ runId: 'run-b', seq: 1, state: 'running' }))
    expect(useProjectSetup.getState().runForGroup('g1')!.state).toBe('running')
    apply(ev({ runId: 'run-b', seq: 2, state: 'done', exitCode: 0 }))
    expect(setupGateDone(useProjectSetup.getState().runForGroup('g1'), false)).toBe(true)
  })

  it('re-attaching moves a lane to the newer run', () => {
    apply(ev({ seq: 1, chunk: 'old\n' }))
    attachProject('p1', 'rk')
    apply(ev({ runKey: 'rk2', runId: 'run-b', seq: 1, chunk: 'new\n' }))
    attachProject('p1', 'rk2')
    expect(runForProject('p1')!.tail).toBe('new\n')
  })
})

describe('setupGateDone — may a node armed on this worktree run yet?', () => {
  const run = (state: SetupRunState['state']): SetupRunState => ({
    runKey: 'rk',
    runId: 'run-a',
    kind: 'setup',
    state,
    tail: '',
    seq: 1
  })

  it('is CLOSED while a launch is pending, even with nothing on record', () => {
    // `projectSetup.run` resolves only after the consent dialog is answered — the window this flag
    // covers is as long as the user takes to read it, not a millisecond.
    expect(setupGateDone(undefined, true)).toBe(false)
  })

  it('stays closed while the run is still going', () => {
    expect(setupGateDone(run('running'), false)).toBe(false)
  })

  it('stays closed on a FAILED run — a half-prepared checkout is not a prepared one', () => {
    expect(setupGateDone(run('failed'), false)).toBe(false)
    expect(setupGateDone(run('cancelled'), false)).toBe(false)
  })

  it('opens on done', () => {
    expect(setupGateDone(run('done'), false)).toBe(true)
  })

  it('opens when nothing is on record and nothing is pending', () => {
    // After an app restart the run store is empty and no event is ever coming; holding here would
    // strand a persisted arming forever.
    expect(setupGateDone(undefined, false)).toBe(true)
  })

  it('pending wins over a stale record of the PREVIOUS run', () => {
    expect(setupGateDone(run('done'), true)).toBe(false)
  })
})

describe('setupAckDecision — what a launch ack obliges the caller to do', () => {
  it('a started run that asks collaborators to wait KEEPS the hold, and claims the lane', () => {
    expect(
      setupAckDecision({ status: 'started', runKey: 'rk', runId: 'r1', waitForSetup: true })
    ).toEqual({ attach: true, hold: 'wait' })
  })

  it('a started run that does NOT ask them to wait releases it (still claiming the lane)', () => {
    expect(
      setupAckDecision({ status: 'started', runKey: 'rk', runId: 'r1', waitForSetup: false })
    ).toEqual({ attach: true, hold: 'release' })
  })

  it('nothing will prepare this checkout → release', () => {
    for (const reason of ['no-script', 'declined', 'unanswered', 'unavailable'] as const) {
      expect(setupAckDecision({ status: 'skipped', reason })).toEqual({
        attach: false,
        hold: 'release'
      })
    }
  })

  it('BUSY keeps the hold — this ack knows nothing about the run that is actually going', () => {
    // The double-clicked re-run chip: the loser gets `busy` while the winner's script runs. Reading
    // that as "nothing is happening" would open the gate over a live checkout.
    expect(setupAckDecision({ status: 'skipped', reason: 'busy' })).toEqual({
      attach: false,
      hold: 'keep'
    })
  })
})

describe('useProjectSetup — in-flight launches per group', () => {
  const pending = (groupId: string): number => useProjectSetup.getState().pendingForGroup(groupId)

  it('DOUBLE DISPATCH: a busy ack decrements one launch and leaves the gate closed', () => {
    const s = (): ReturnType<typeof useProjectSetup.getState> => useProjectSetup.getState()
    // Two clicks on the re-run chip inside the consent window: two launches in flight.
    s().markGroupPending('g1')
    s().markGroupPending('g1')
    expect(pending('g1')).toBe(2)
    // The loser comes back `busy` (its caller clears exactly one).
    s().clearGroupPending('g1')
    expect(pending('g1')).toBe(1)
    expect(setupGateDone(s().runForGroup('g1'), pending('g1') > 0)).toBe(false)
    // The winner's ack lands: its run is attached and live — still closed, now on the run itself.
    s().clearGroupPending('g1')
    s().attachGroup('g1', 'rk')
    apply(ev({ seq: 1, state: 'running' }))
    expect(pending('g1')).toBe(0)
    expect(setupGateDone(s().runForGroup('g1'), pending('g1') > 0)).toBe(false)
    // …and only its `done` opens it.
    apply(ev({ seq: 2, state: 'done', exitCode: 0 }))
    expect(setupGateDone(s().runForGroup('g1'), pending('g1') > 0)).toBe(true)
  })

  it('never goes negative, and an exhausted group leaves no entry behind', () => {
    useProjectSetup.getState().markGroupPending('g1')
    useProjectSetup.getState().clearGroupPending('g1')
    useProjectSetup.getState().clearGroupPending('g1')
    expect(pending('g1')).toBe(0)
    expect(useProjectSetup.getState().pendingByGroup.g1).toBeUndefined()
  })

  it('counts per group — one worktree’s launch never gates another’s', () => {
    useProjectSetup.getState().markGroupPending('g1')
    expect(pending('g1')).toBe(1)
    expect(pending('g2')).toBe(0)
  })
})

describe('useProjectSetup — subscription', () => {
  it('wires api.projectSetup.onEvent into applyEvent and returns its unsubscribe', () => {
    let emit: ((e: ProjectSetupEvent) => void) | null = null
    const off = vi.fn()
    const onEvent = vi.fn((_projectId: string, cb: (e: ProjectSetupEvent) => void) => {
      emit = cb
      return off
    })
    ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { projectSetup: { onEvent } }
    const unsubscribe = useProjectSetup.getState().subscribeProject('p1')
    expect(onEvent).toHaveBeenCalledWith('p1', expect.any(Function))
    emit!(ev({ seq: 1, chunk: 'from the wire' }))
    expect(useProjectSetup.getState().byRunKey.rk!.tail).toBe('from the wire')
    unsubscribe()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
