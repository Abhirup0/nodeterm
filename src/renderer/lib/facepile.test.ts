import { describe, it, expect } from 'vitest'
import { PRESENCE_COLORS } from '@shared/presence'
import { faceClickTarget, facepileEntries, initials, type FacepileEntry } from './facepile'
import type { PeerFace } from '../state/presence'

function face(clientId: number, over: Partial<PeerFace> = {}): PeerFace {
  return {
    clientId,
    name: `P${clientId}`,
    color: PRESENCE_COLORS[0],
    projectId: 'web',
    kind: 'browser',
    ...over
  }
}

const PROJECTS = { web: 'web', api: 'api' }

const only = (
  faces: PeerFace[],
  active: string | null,
  focus: Record<number, string | null> = {}
): FacepileEntry => facepileEntries(faces, PROJECTS, active, focus)[0]

describe('initials', () => {
  it('takes the first letter of the first two words', () => {
    expect(initials('Enes Kirca')).toBe('EK')
    expect(initials('  ada  lovelace  byron ')).toBe('AL')
  })

  it('takes two letters from a single word, and falls back for an empty name', () => {
    expect(initials('Phone')).toBe('PH')
    expect(initials('x')).toBe('X')
    expect(initials('   ')).toBe('?')
  })
})

describe('facepileEntries', () => {
  it('shows a peer on this canvas undimmed, labelled by name alone', () => {
    const e = only([face(8, { name: 'Ada' })], 'web', { 8: 'term-1' })
    expect(e.away).toBe(false)
    expect(e.label).toBe('Ada')
    expect(e.initials).toBe('AD')
    expect(e.projectName).toBe('web')
    expect(e.actionable).toBe(true) // clicking centers their node
  })

  it('does not pretend a peer on this canvas focused on nothing is clickable', () => {
    // The only thing a click could resolve to is "switch to the project you are already on".
    const e = only([face(8, { name: 'Ada' })], 'web', {})
    expect(e.away).toBe(false)
    expect(e.projectName).toBe('web')
    expect(e.actionable).toBe(false)
    expect(faceClickTarget(e, null)).toBeNull()
  })

  it('shows an off-project peer dimmed and labelled with their project ("Ada · api")', () => {
    const e = only([face(8, { name: 'Ada', projectId: 'api' })], 'web')
    expect(e.away).toBe(true)
    expect(e.projectName).toBe('api')
    expect(e.label).toBe('Ada · api')
    expect(e.actionable).toBe(true) // clicking takes you there
  })

  it('degrades gracefully for a project we do not have: no broken label, not clickable', () => {
    const e = only([face(8, { name: 'Ada', projectId: 'ghost' })], 'web')
    expect(e.away).toBe(true)
    expect(e.projectName).toBeNull()
    expect(e.label).toBe('Ada') // never "Ada · undefined"
    expect(e.actionable).toBe(false)
    expect(e.title).not.toContain('·')
  })

  it('degrades gracefully for a peer with no project open (welcome screen)', () => {
    const e = only([face(8, { name: 'Ada', projectId: null })], 'web')
    expect(e.away).toBe(true)
    expect(e.projectName).toBeNull()
    expect(e.label).toBe('Ada')
    expect(e.actionable).toBe(false)
  })

  it('treats every peer as away when no project is open here', () => {
    const entries = facepileEntries([face(8), face(9, { projectId: 'api' })], PROJECTS, null)
    expect(entries.map((e) => e.away)).toEqual([true, true])
    // ...but they are still reachable: that is how you get off the welcome screen to a teammate.
    expect(entries.map((e) => e.actionable)).toEqual([true, true])
  })

  it('marks a cursorless phone so the facepile can give it a phone affordance', () => {
    const phone = only([face(8, { name: 'Phone', kind: 'phone' })], 'web')
    expect(phone.isPhone).toBe(true)
    expect(only([face(8)], 'web').isPhone).toBe(false)
  })

  it('does not stutter "phone" in the title when the name already says it', () => {
    // The hub's default name for a phone peer IS "Phone" — "Phone · phone" is noise.
    expect(only([face(8, { name: 'Phone', kind: 'phone' })], 'web').title).toBe('Phone')
    expect(only([face(8, { name: "Ada's iPhone", kind: 'phone' })], 'web').title).toBe(
      "Ada's iPhone"
    )
    // A named phone still gets the qualifier — that is the only hint it has no cursor.
    expect(only([face(8, { name: 'Ada', kind: 'phone' })], 'web').title).toBe('Ada · phone')
  })

  it('carries the peer color through untouched (palette-sanitized on the wire)', () => {
    expect(only([face(8, { color: PRESENCE_COLORS[3] })], 'web').color).toBe(PRESENCE_COLORS[3])
  })

  it('keeps the peer order it is given and preserves clientIds', () => {
    const entries = facepileEntries([face(9), face(8)], PROJECTS, 'web')
    expect(entries.map((e) => e.clientId)).toEqual([9, 8])
  })
})

describe('faceClickTarget', () => {
  const entry = (over: Partial<FacepileEntry> = {}): FacepileEntry =>
    ({ projectId: 'api', away: true, actionable: true, ...over }) as FacepileEntry

  it('jumps to the peer’s focused node when they have one (focusNodeById switches projects)', () => {
    expect(faceClickTarget(entry(), 'term-1')).toEqual({ kind: 'node', nodeId: 'term-1' })
  })

  it('falls back to their project when they are focused on nothing', () => {
    expect(faceClickTarget(entry({ away: true }), null)).toEqual({
      kind: 'project',
      projectId: 'api'
    })
  })

  it('goes nowhere for a peer on the canvas we are already on with no focused node', () => {
    // Focus is read live at click time, so it can go null between render and click — the click
    // must then be inert rather than "switch to the project you are already on".
    expect(faceClickTarget(entry({ away: false, projectId: 'web' }), null)).toBeNull()
  })

  it('goes nowhere for a peer we cannot follow (unknown / no project)', () => {
    // Even a focused node: its project is not in our workspace, so we could not open it.
    expect(faceClickTarget(entry({ actionable: false }), 'term-1')).toBeNull()
    expect(faceClickTarget(entry({ actionable: false, projectId: null }), null)).toBeNull()
  })
})
