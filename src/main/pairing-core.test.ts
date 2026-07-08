import { describe, it, expect } from 'vitest'
import {
  buildPairingPayload,
  isValidEd25519PublicKey,
  normalizeAuthorizedKeysLine,
  pickLanIPv4
} from './pairing-core'

// A real Ed25519 public key blob (32 zero bytes) wrapped in the OpenSSH wire format:
// uint32(len "ssh-ed25519") + "ssh-ed25519" + uint32(32) + 32 bytes.
function makeEd25519Blob(): string {
  const name = Buffer.from('ssh-ed25519', 'ascii')
  const key = Buffer.alloc(32)
  const buf = Buffer.concat([
    u32(name.length),
    name,
    u32(key.length),
    key
  ])
  return buf.toString('base64')
}
function u32(n: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n, 0)
  return b
}

describe('buildPairingPayload', () => {
  it('emits single-line JSON with the fixed key order and defaults', () => {
    const json = buildPairingPayload({
      host: '192.168.1.5',
      user: 'enes',
      token: 'tok123',
      pairPort: 54321,
      name: 'MacBook'
    })
    expect(json).toBe(
      '{"v":1,"host":"192.168.1.5","port":22,"user":"enes","token":"tok123","pairPort":54321,"nodeterm":true,"name":"MacBook"}'
    )
    expect(json).not.toContain('\n')
    expect(JSON.parse(json)).toMatchObject({ v: 1, port: 22, nodeterm: true })
  })

  it('honors an explicit port override', () => {
    const json = buildPairingPayload({
      host: 'h',
      port: 2222,
      user: 'u',
      token: 't',
      pairPort: 1,
      name: 'n'
    })
    expect(JSON.parse(json).port).toBe(2222)
  })
})

describe('isValidEd25519PublicKey', () => {
  const blob = makeEd25519Blob()

  it('accepts a well-formed ssh-ed25519 line with a comment', () => {
    expect(isValidEd25519PublicKey(`ssh-ed25519 ${blob} phone@nodeterm`)).toBe(true)
  })

  it('accepts a line without a comment', () => {
    expect(isValidEd25519PublicKey(`ssh-ed25519 ${blob}`)).toBe(true)
  })

  it('rejects a non-ed25519 key type', () => {
    expect(isValidEd25519PublicKey(`ssh-rsa ${blob} x`)).toBe(false)
  })

  it('rejects a spoofed prefix with a garbage blob', () => {
    expect(isValidEd25519PublicKey('ssh-ed25519 not-base64!!!')).toBe(false)
  })

  it('rejects an ed25519 prefix whose embedded name disagrees', () => {
    // Base64 blob whose wire-format name is "ssh-rsa" but prefixed textually as ed25519.
    const name = Buffer.from('ssh-rsa', 'ascii')
    const fake = Buffer.concat([u32(name.length), name, u32(0)]).toString('base64')
    expect(isValidEd25519PublicKey(`ssh-ed25519 ${fake}`)).toBe(false)
  })

  it('rejects empty / malformed lines', () => {
    expect(isValidEd25519PublicKey('')).toBe(false)
    expect(isValidEd25519PublicKey('ssh-ed25519')).toBe(false)
  })
})

describe('normalizeAuthorizedKeysLine', () => {
  it('trims and collapses whitespace to a single line', () => {
    expect(normalizeAuthorizedKeysLine('  ssh-ed25519   AAAA   phone\n')).toBe(
      'ssh-ed25519 AAAA phone'
    )
  })
})

describe('pickLanIPv4', () => {
  it('picks the first non-internal, non-link-local IPv4', () => {
    const picked = pickLanIPv4({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
      en0: [
        { address: 'fe80::1', family: 'IPv6', internal: false },
        { address: '169.254.10.1', family: 'IPv4', internal: false },
        { address: '192.168.1.42', family: 'IPv4', internal: false }
      ]
    })
    expect(picked).toBe('192.168.1.42')
  })

  it('accepts the numeric family form (family: 4)', () => {
    expect(
      pickLanIPv4({ en0: [{ address: '10.0.0.2', family: 4, internal: false }] })
    ).toBe('10.0.0.2')
  })

  it('returns null when nothing suitable exists', () => {
    expect(
      pickLanIPv4({
        lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        en0: [{ address: '169.254.1.1', family: 'IPv4', internal: false }]
      })
    ).toBe(null)
  })
})
