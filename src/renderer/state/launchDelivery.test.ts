import { describe, it, expect, beforeEach } from 'vitest'
import { useLaunchDelivery } from './launchDelivery'

/**
 * Issue #569 item 1 — the transient record behind the QUEUED badge's warning.
 *
 * The rule the whole store exists for: a launch that was abandoned must be VISIBLE. It used to be
 * a `console.warn` and nothing else, so a node that never started looked exactly like one still
 * waiting on a dependency — from the canvas and, more expensively, from an orchestrator driving
 * the canvas from outside.
 */
describe('useLaunchDelivery', () => {
  beforeEach(() => useLaunchDelivery.setState({ byId: {} }))

  it('reports nothing by default — absent is "waiting normally", not "fine"', () => {
    expect(useLaunchDelivery.getState().byId['term-1']).toBeUndefined()
  })

  it('markStalled is idempotent: the age does not restart on every re-render', () => {
    const s = useLaunchDelivery.getState()
    s.markStalled('term-1')
    const first = useLaunchDelivery.getState().byId['term-1']
    s.markStalled('term-1')
    expect(useLaunchDelivery.getState().byId['term-1']).toBe(first)
  })

  it('never downgrades a failure back to a stall', () => {
    const s = useLaunchDelivery.getState()
    s.markFailed('term-1', 5)
    s.markStalled('term-1')
    expect(useLaunchDelivery.getState().byId['term-1']?.kind).toBe('failed')
  })

  it('keeps the LARGER attempt count — the manual ▶ must not rewrite history', () => {
    const s = useLaunchDelivery.getState()
    s.markFailed('term-1', 5)
    s.markFailed('term-1', 1) // the ▶ button's single refusal
    const st = useLaunchDelivery.getState().byId['term-1']
    expect(st).toMatchObject({ kind: 'failed', attempts: 5 })
  })

  it('clear removes the entry, and clearing an unknown id changes nothing', () => {
    const s = useLaunchDelivery.getState()
    s.markFailed('term-1', 2)
    const before = useLaunchDelivery.getState().byId
    s.clear('term-nope')
    expect(useLaunchDelivery.getState().byId).toBe(before)
    s.clear('term-1')
    expect(useLaunchDelivery.getState().byId['term-1']).toBeUndefined()
  })
})
