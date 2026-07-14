import { describe, it, expect } from 'vitest'
import { shouldSpectate } from './dino-authority'

/**
 * The authority tiebreak: given my clientId, the peer broadcasting for this node, and whether my
 * own engine currently authors a run, decide whether I spectate the peer or keep playing locally.
 * Lower clientId wins — so I keep playing only when I already author AND my id beats the peer's.
 */
describe('shouldSpectate', () => {
  it('no peer broadcasting → play locally (false)', () => {
    expect(shouldSpectate({ myId: 1, peerClientId: null, iAmAuthority: false })).toBe(false)
    expect(shouldSpectate({ myId: 1, peerClientId: null, iAmAuthority: true })).toBe(false)
  })

  it('a peer broadcasts and I do not author → spectate (true)', () => {
    expect(shouldSpectate({ myId: 5, peerClientId: 2, iAmAuthority: false })).toBe(true)
  })

  it('a peer broadcasts, I author, my id is LOWER → keep playing (false), the peer yields', () => {
    expect(shouldSpectate({ myId: 1, peerClientId: 5, iAmAuthority: true })).toBe(false)
  })

  it('a peer broadcasts, I author, my id is HIGHER → yield and spectate (true)', () => {
    expect(shouldSpectate({ myId: 9, peerClientId: 5, iAmAuthority: true })).toBe(true)
  })

  it('myId is null (hello in flight) → cannot win the tiebreak, so spectate (true)', () => {
    expect(shouldSpectate({ myId: null, peerClientId: 5, iAmAuthority: true })).toBe(true)
  })
})
