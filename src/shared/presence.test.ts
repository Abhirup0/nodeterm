import { describe, it, expect } from 'vitest'
import {
  PRESENCE_COLORS,
  capCodePoints,
  defaultNameFor,
  nextFreeColor,
  peersOnProject,
  sanitizeIdentity,
  CHAT_MAX_LEN,
  NAME_MAX_LEN,
  type PeerDiff,
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
  })

  it('wraps by taken-count once every color is in use (the exact documented rule)', () => {
    // Every color taken → the (n+1)-th peer reuses PRESENCE_COLORS[taken.length % length]
    // rather than going colorless. Pin the exact color: "some palette color" would also pass
    // for a random-color implementation.
    const all = [...PRESENCE_COLORS]
    expect(nextFreeColor(all)).toBe(PRESENCE_COLORS[all.length % PRESENCE_COLORS.length])
    expect(nextFreeColor(all)).toBe(PRESENCE_COLORS[0])
    expect(nextFreeColor([...all, PRESENCE_COLORS[0]])).toBe(PRESENCE_COLORS[1])
    expect(nextFreeColor([...all, PRESENCE_COLORS[0], PRESENCE_COLORS[1]])).toBe(PRESENCE_COLORS[2])
  })

  it('is a readonly palette (no consumer can corrupt color assignment app-wide)', () => {
    // @ts-expect-error PRESENCE_COLORS is readonly — pushing into it must not typecheck.
    expect(() => PRESENCE_COLORS.push('#000000')).toBeDefined()
    // Callers stay unconstrained: a mutable array is still an acceptable `taken` argument.
    const mutable: string[] = [PRESENCE_COLORS[0]]
    expect(nextFreeColor(mutable)).toBe(PRESENCE_COLORS[1])
  })
})

describe('PeerDiff (wire contract)', () => {
  it('cannot rewrite the identity key through an update patch', () => {
    const ok: PeerDiff = { op: 'update', clientId: 3, patch: { focus: 'n1', chat: 'hi' } }
    expect(ok.op).toBe('update')
    // @ts-expect-error an update patch must not be able to reassign clientId.
    const bad: PeerDiff = { op: 'update', clientId: 3, patch: { clientId: 7 } }
    expect(bad).toBeDefined()
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

  it('caps by code point, never splitting an astral-plane character in half', () => {
    // 31 ASCII + 2 emoji: the cap lands mid-emoji. Cutting by UTF-16 code unit would leave a
    // lone surrogate, which every peer's facepile renders as "�".
    const name = 'x'.repeat(NAME_MAX_LEN - 1) + '😀😀'
    const out = sanitizeIdentity({ name, color: PRESENCE_COLORS[0] }, fallback).name
    expect(out).toBe('x'.repeat(NAME_MAX_LEN - 1) + '😀')
    expect([...out]).toHaveLength(NAME_MAX_LEN)
    expect(out).not.toMatch(/[\uD800-\uDFFF]/u) // no unpaired surrogate survived
    expect(out).not.toContain('�')
  })

  it('trims after truncating, so a cap landing on a space leaves no trailing space', () => {
    const name = 'a'.repeat(NAME_MAX_LEN - 1) + ' tail'
    const out = sanitizeIdentity({ name, color: PRESENCE_COLORS[0] }, fallback).name
    expect(out).toBe('a'.repeat(NAME_MAX_LEN - 1))
  })
})

describe('capCodePoints (the one truncation rule — and the one untrusted-length door)', () => {
  it('caps by code point and leaves a short string alone', () => {
    expect(capCodePoints('hello', 10)).toBe('hello')
    expect(capCodePoints('hello', 3)).toBe('hel')
    expect(capCodePoints('', 3)).toBe('')
    expect(capCodePoints('abc', 0)).toBe('')
  })

  it('never cuts a surrogate pair in half, wherever the cap lands', () => {
    // Every code point is astral: the cap in code UNITS would be 2× the cap in code POINTS, so an
    // implementation that bounds the input by code units must still not hand back half a pair.
    const emoji = '😀'.repeat(500)
    const out = capCodePoints(emoji, 200)
    expect([...out]).toHaveLength(200)
    expect(out).toBe('😀'.repeat(200))
    expect(out).not.toMatch(/[\uD800-\uDFFF]/u)

    // A pair straddling the max*2 code-unit boundary of a bounded implementation.
    const straddle = 'a' + '😀'.repeat(500)
    const cut = capCodePoints(straddle, 200)
    expect([...cut]).toHaveLength(200)
    expect(cut).toBe('a' + '😀'.repeat(199))
    expect(cut).not.toMatch(/[\uD800-\uDFFF]/u)
  })

  it('caps a huge hostile string WITHOUT materializing it (cost is O(max), not O(input))', () => {
    // A client can cast a `presence:chat` of whatever size the socket accepts. The old
    // `[...text].slice(0, max)` spread the WHOLE string into an array of code points first: for a
    // 40 MB frame that is ~20M array elements — seconds of blocked event loop and ~1 GB of heap,
    // i.e. a trivial remote DoS on the shared Server Edition process. Bounding the input first
    // makes the work proportional to `max`, so this is milliseconds.
    const hostile = 'a'.repeat(40_000_000)
    const started = performance.now()
    const out = capCodePoints(hostile, CHAT_MAX_LEN)
    const elapsed = performance.now() - started
    expect(out).toBe('a'.repeat(CHAT_MAX_LEN))
    // Generous by two orders of magnitude: the bounded implementation runs in µs, while the
    // spreading one cannot get near this even on a fast machine.
    expect(elapsed).toBeLessThan(200)
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
