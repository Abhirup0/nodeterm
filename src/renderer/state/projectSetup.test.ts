// @vitest-environment jsdom
//
// The renderer's view of a setup/archive run. Everything here exists because the event stream is a
// LOSSY, RE-ORDERABLE wire: `ProjectSetupEvent.seq` is monotonic per run precisely so a client can
// tell a duplicate (relay re-delivery) from a fresh chunk, and the output of a script is unbounded
// while the panel's box is not.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ProjectSetupEvent } from '@shared/project-settings'
import { SETUP_TAIL_MAX, useProjectSetup } from './projectSetup'

const ev = (over: Partial<ProjectSetupEvent> = {}): ProjectSetupEvent => ({
  runKey: 'r1',
  kind: 'setup',
  seq: 1,
  state: 'running',
  ...over
})

const apply = (e: ProjectSetupEvent, groupId?: string): void =>
  useProjectSetup.getState().applyEvent('p1', e, groupId)

beforeEach(() => {
  useProjectSetup.setState({ byProject: {}, byGroup: {} })
})

describe('useProjectSetup', () => {
  it('opens a run entry from the first event and appends chunks in seq order', () => {
    apply(ev({ seq: 1, chunk: 'installing…\n' }))
    apply(ev({ seq: 2, chunk: 'done\n' }))
    const run = useProjectSetup.getState().byProject.p1!
    expect(run.runKey).toBe('r1')
    expect(run.kind).toBe('setup')
    expect(run.state).toBe('running')
    expect(run.tail).toBe('installing…\ndone\n')
  })

  it('drops a DUPLICATE seq — a re-delivered event must not double the output', () => {
    apply(ev({ seq: 1, chunk: 'a' }))
    apply(ev({ seq: 2, chunk: 'b' }))
    apply(ev({ seq: 2, chunk: 'b' }))
    expect(useProjectSetup.getState().byProject.p1!.tail).toBe('ab')
  })

  it('drops a STALE seq that arrives after a newer one', () => {
    apply(ev({ seq: 1, chunk: 'a' }))
    apply(ev({ seq: 3, chunk: 'c' }))
    // seq 2 lost the race; re-inserting it here would put the output out of order AND would let a
    // stale `running` overwrite a terminal state.
    apply(ev({ seq: 2, chunk: 'b', state: 'done', exitCode: 0 }))
    const run = useProjectSetup.getState().byProject.p1!
    expect(run.tail).toBe('ac')
    expect(run.state).toBe('running')
    expect(run.exitCode).toBeUndefined()
  })

  it('caps the tail at 8 KB, keeping the END (the failure is at the bottom, not the top)', () => {
    apply(ev({ seq: 1, chunk: 'x'.repeat(SETUP_TAIL_MAX) }))
    apply(ev({ seq: 2, chunk: 'TAIL' }))
    const { tail } = useProjectSetup.getState().byProject.p1!
    expect(tail.length).toBe(SETUP_TAIL_MAX)
    expect(tail.endsWith('TAIL')).toBe(true)
    expect(tail.startsWith('x')).toBe(true)
  })

  it('caps a single over-long chunk too', () => {
    apply(ev({ seq: 1, chunk: 'y'.repeat(SETUP_TAIL_MAX * 3) }))
    expect(useProjectSetup.getState().byProject.p1!.tail.length).toBe(SETUP_TAIL_MAX)
  })

  it('records the terminal state and exit code', () => {
    apply(ev({ seq: 1, chunk: 'boom\n' }))
    apply(ev({ seq: 2, state: 'failed', exitCode: 2 }))
    const run = useProjectSetup.getState().byProject.p1!
    expect(run.state).toBe('failed')
    expect(run.exitCode).toBe(2)
    expect(run.tail).toBe('boom\n')
  })

  it('a NEW runKey starts a fresh entry — the previous run’s output never bleeds into it', () => {
    apply(ev({ seq: 1, chunk: 'first run\n' }))
    apply(ev({ seq: 2, state: 'done', exitCode: 0 }))
    apply(ev({ runKey: 'r2', kind: 'archive', seq: 1, chunk: 'second\n' }))
    const run = useProjectSetup.getState().byProject.p1!
    expect(run.runKey).toBe('r2')
    expect(run.kind).toBe('archive')
    expect(run.state).toBe('running')
    expect(run.tail).toBe('second\n')
    expect(run.exitCode).toBeUndefined()
  })

  it('routes a worktree run to byGroup, leaving the project entry alone', () => {
    apply(ev({ seq: 1, chunk: 'project\n' }))
    apply(ev({ runKey: 'r9', seq: 1, chunk: 'group\n' }), 'g1')
    expect(useProjectSetup.getState().byProject.p1!.tail).toBe('project\n')
    expect(useProjectSetup.getState().byGroup.g1!.tail).toBe('group\n')
    // …and the two dedupe independently: same seq, different lane.
    apply(ev({ runKey: 'r9', seq: 2, chunk: 'more\n' }), 'g1')
    expect(useProjectSetup.getState().byGroup.g1!.tail).toBe('group\nmore\n')
  })

  it('subscribeProject wires api.projectSetup.onEvent into applyEvent and returns its unsubscribe', () => {
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
    expect(useProjectSetup.getState().byProject.p1!.tail).toBe('from the wire')
    unsubscribe()
    expect(off).toHaveBeenCalledTimes(1)
  })
})
