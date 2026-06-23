import { describe, it, expect } from 'vitest'
import { encodeOffer, decodeOffer, type PairingOffer } from '../../src/main/remote/pairing'

const sample: PairingOffer = {
  relayEndpoint: 'wss://relay.nodeterm.dev/socket',
  pairingToken: 'tok_abc123',
  hostPublicKeyB64: 'aGVsbG8td29ybGQtcHVibGljLWtleQ=='
}

describe('pairing', () => {
  it('round-trips decodeOffer(encodeOffer(o))', () => {
    const url = encodeOffer(sample)
    expect(url.startsWith('nodeterm://pair?code=')).toBe(true)
    const out = decodeOffer(url)
    expect(out).toEqual(sample)
  })

  it('decodeOffer accepts the bare base64url code too', () => {
    const url = encodeOffer(sample)
    const code = url.slice('nodeterm://pair?code='.length)
    expect(decodeOffer(code)).toEqual(sample)
  })

  it('decodeOffer("garbage") === null', () => {
    expect(decodeOffer('garbage')).toBeNull()
  })

  it('decodeOffer of a wrong-scheme URL === null', () => {
    expect(decodeOffer('https://example.com/pair?code=abc')).toBeNull()
  })

  it('decodeOffer of an incomplete offer === null', () => {
    const json = JSON.stringify({ relayEndpoint: 'wss://x' })
    const code = Buffer.from(json, 'utf-8').toString('base64url')
    expect(decodeOffer(`nodeterm://pair?code=${code}`)).toBeNull()
  })
})
