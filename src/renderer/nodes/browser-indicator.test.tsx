// @vitest-environment jsdom
//
// The driving chip (S8 PR 6 of #112, @Corvin): it appears while an agent holds a lease, names the
// VERIFIED owner, carries a Stop, LINGERS past a lease's end so a burst of fast verbs reads as one
// continuous state, and drops AT ONCE on an explicit Stop. And no setting hides it (decision 4).
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { chipVisibleAt, INDICATOR_LINGER_MS } from '@shared/browser-indicator'
import { applyLeasePush, drivingNodeIds, type LeaseEntries } from '../state/browserLease'
import { BrowserDrivingChip } from './BrowserDrivingChip'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const T0 = 1_000_000
const active = (leaseActiveUntil: number, id = 'browser-3', ownerNodeId = 'claude-2') => ({
  active: [{ browserNodeId: id, ownerNodeId, leaseActiveUntil }],
  stopped: [] as string[]
})

describe('the chip lingers, because a 50ms flicker has informed nobody', () => {
  it('a lease that was live for ~50ms keeps the chip up for INDICATOR_LINGER_MS after it ends', () => {
    // A --read completes in ~50ms: the lease is barely in the future when we learn of it.
    const entries: LeaseEntries = applyLeasePush({}, active(T0 + 50), T0)
    const e = entries['browser-3']
    expect(e.ownerNodeId).toBe('claude-2')

    // Still driving well after the 50ms lease ended — this is the whole point of the linger.
    expect(chipVisibleAt(e, T0 + 50)).toBe(true)
    expect(chipVisibleAt(e, T0 + 2_000)).toBe(true)
    // …and gone once the linger itself lapses.
    expect(chipVisibleAt(e, T0 + 50 + INDICATOR_LINGER_MS + 1)).toBe(false)
    // A burst reads as continuous: the SAME entry is visible across the gap between two 50ms verbs.
    expect(chipVisibleAt(e, T0 + 4_000)).toBe(true)
  })

  it('a natural expiry is swept only once the linger is truly past', () => {
    const entries = applyLeasePush({}, active(T0 + 50), T0)
    // A later push at a time still inside the linger keeps the entry (an unrelated change).
    const still = applyLeasePush(entries, { active: [], stopped: [] }, T0 + 2_000)
    expect(still['browser-3']).toBeTruthy()
    // A push after the linger sweeps it.
    const gone = applyLeasePush(entries, { active: [], stopped: [] }, T0 + 50 + INDICATOR_LINGER_MS + 1)
    expect(gone['browser-3']).toBeUndefined()
  })
})

describe('an explicit Stop drops the chip immediately, skipping the linger', () => {
  it('a stopped id is removed at once, even mid-linger', () => {
    const entries = applyLeasePush({}, active(T0 + 60_000), T0) // a normal 60s lease
    expect(entries['browser-3']).toBeTruthy()
    // Stop arrives: the node is in `stopped`. It must be gone NOW, not in 5s.
    const afterStop = applyLeasePush(entries, { active: [], stopped: ['browser-3'] }, T0 + 10)
    expect(afterStop['browser-3']).toBeUndefined()
  })

  it('the rope-highlight set is exactly the visible-lease set (a rope with no entry is never in it)', () => {
    const entries = applyLeasePush({}, active(T0 + 60_000, 'browser-9'), T0)
    const driven = drivingNodeIds(entries, T0 + 5)
    expect(driven.has('browser-9')).toBe(true)
    // A browser node with no ledger-backed entry (e.g. a hostile pre-declared rope's target).
    expect(driven.has('browser-unclaimed')).toBe(false)
  })
})

describe('the chip names the owner and carries a Stop', () => {
  it('renders "<owner> is driving" and Stop calls back', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const onStop = vi.fn()
    act(() => root.render(<BrowserDrivingChip ownerTitle="Claude 2" onStop={onStop} />))

    expect(host.textContent).toContain('Claude 2 is driving')
    const stop = host.querySelector('button.browser-driving__stop') as HTMLButtonElement
    expect(stop).toBeTruthy()
    act(() => stop.click())
    expect(onStop).toHaveBeenCalledTimes(1)

    act(() => root.unmount())
    host.remove()
  })
})

describe('no setting hides it (decision 4 — there is no toggle to look for and none to add)', () => {
  it('visibility is a pure function of lease state — the chip renders whenever a lease is present', () => {
    // There is no `enabled`/`setting` input to chipVisibleAt: give it any live entry and it shows.
    expect(chipVisibleAt({ ownerNodeId: 'x', leaseActiveUntil: T0 + 1 }, T0)).toBe(true)
  })

  it('neither the chip nor the lease store consults settings / the capability switch', () => {
    // A structural guard: the moment someone adds a `useSettings`/`agentBrowserControl` gate to the
    // indicator, this fails. The chip is gated ONLY on the presence of a verified lease.
    const root = path.resolve(process.cwd(), 'src', 'renderer')
    const chip = readFileSync(path.join(root, 'nodes', 'BrowserDrivingChip.tsx'), 'utf8')
    const store = readFileSync(path.join(root, 'state', 'browserLease.ts'), 'utf8')
    // Strip comments — the chip's doc comment explains that it is NOT gated on the capability
    // switch, and that explanation is a comment, correctly ignored here (same style as
    // browser-ownership-source.test.ts).
    const stripComments = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    for (const src of [chip, store]) {
      expect(stripComments(src)).not.toMatch(/useSettings|agentBrowserControl|hiddenNodeMenuItems/)
    }
  })
})
