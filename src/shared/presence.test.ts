import { describe, it, expect } from 'vitest'
import {
  PRESENCE_COLORS,
  defaultNameFor,
  nextFreeColor,
  peersOnProject,
  sanitizeIdentity,
  NAME_MAX_LEN,
  CHAT_MAX_LEN,
  type PeerState
} from './presence'

function peer(clientId: number, projectId: string | null): PeerState {
  return {
    clientId,
    name: `P${clientId}`,
    color: PRESENCE_COLORS[0],
    cursor: { x: 0, y: 0 },
    focus: null,
    chat: null,
    typing: null,
    projectId,
    kind: 'browser'
  }
}

describe('presence palette', () => {
  it('hands out the first unused color, then wraps around when the palette is exhausted', () => {
    expect(nextFreeColor([])).toBe(PRESENCE_COLORS[0])
    expect(nextFreeColor([PRESENCE_COLORS[0]])).toBe(PRESENCE_COLORS[1])
    expect(nextFreeColor([PRESENCE_COLORS[1]])).toBe(PRESENCE_COLORS[0])
    // Every color taken → wrap (a 9th peer reuses the 1st color rather than going colorless).
    expect(PRESENCE_COLORS).toContain(nextFreeColor([...PRESENCE_COLORS]))
  })
})

describe('defaultNameFor', () => {
  it('names a phone "Phone" and anything else "Someone" until presence:hello arrives', () => {
    expect(defaultNameFor('phone')).toBe('Phone')
    expect(defaultNameFor('browser')).toBe('Someone')
    expect(defaultNameFor('desktop')).toBe('Someone')
  })
})

describe('sanitizeIdentity', () => {
  const fallback = { name: 'Someone', color: PRESENCE_COLORS[0] }

  it('trims and caps the name, and keeps a palette color', () => {
    expect(sanitizeIdentity({ name: '  Enes  ', color: PRESENCE_COLORS[2] }, fallback)).toEqual({
      name: 'Enes',
      color: PRESENCE_COLORS[2]
    })
    const long = 'x'.repeat(200)
    expect(sanitizeIdentity({ name: long, color: PRESENCE_COLORS[1] }, fallback).name).toHaveLength(
      NAME_MAX_LEN
    )
  })

  it('falls back on junk: non-object, empty name, off-palette or non-string color', () => {
    expect(sanitizeIdentity(null, fallback)).toEqual(fallback)
    expect(sanitizeIdentity({ name: '   ', color: PRESENCE_COLORS[1] }, fallback).name).toBe(
      fallback.name
    )
    expect(sanitizeIdentity({ name: 'Enes', color: 'javascript:alert(1)' }, fallback).color).toBe(
      fallback.color
    )
    expect(sanitizeIdentity({ name: 'Enes', color: 42 }, fallback).color).toBe(fallback.color)
  })

  it('exposes a chat cap so a peer cannot flood the wire', () => {
    expect(CHAT_MAX_LEN).toBeGreaterThan(0)
  })
})

describe('peersOnProject (the one project filter: cursors, bubbles, node chips)', () => {
  const peers = [peer(1, 'web'), peer(2, 'api'), peer(3, null), peer(4, 'web')]

  it('keeps only the peers on the same canvas', () => {
    expect(peersOnProject(peers, 'web').map((p) => p.clientId)).toEqual([1, 4])
    expect(peersOnProject(peers, 'api').map((p) => p.clientId)).toEqual([2])
  })

  it('draws nothing when no project is open (welcome screen) and never matches a null peer', () => {
    expect(peersOnProject(peers, null)).toEqual([])
    // A peer with no project open must not leak onto anyone's canvas.
    expect(peersOnProject(peers, 'web').some((p) => p.projectId === null)).toBe(false)
  })
})
