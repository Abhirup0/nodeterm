// Pure helpers for the phone-pairing service (no I/O), so they can be unit-tested with fakes.
//
// The QR payload + the authorized_keys line validation are the two bits of the pairing flow
// with a fixed on-the-wire contract shared with the nodeterm iOS app — keep them here, pure.

/** Inputs for the QR payload the iOS app scans. `port` defaults to 22 (SSH). */
export interface PairingPayloadInput {
  host: string
  port?: number
  user: string
  token: string
  pairPort: number
  name: string
}

/**
 * Build the single-line JSON the QR encodes. The key order + compact separators match the
 * contract the phone parses:
 *   {"v":1,"host":"…","port":22,"user":"…","token":"…","pairPort":N,"nodeterm":true,"name":"…"}
 */
export function buildPairingPayload(input: PairingPayloadInput): string {
  return JSON.stringify({
    v: 1,
    host: input.host,
    port: input.port ?? 22,
    user: input.user,
    token: input.token,
    pairPort: input.pairPort,
    nodeterm: true,
    name: input.name
  })
}

/**
 * Validate that a phone-supplied public key is a well-formed `ssh-ed25519` line
 * (`ssh-ed25519 AAAA… comment`). Anything else → the listener answers 400.
 * Beyond the textual prefix we decode the base64 blob and check its embedded algorithm
 * name, so a spoofed `ssh-ed25519 <garbage>` line can't slip through.
 */
export function isValidEd25519PublicKey(line: string): boolean {
  const parts = line.trim().split(/\s+/)
  if (parts.length < 2) return false
  if (parts[0] !== 'ssh-ed25519') return false
  const b64 = parts[1]
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return false
  let buf: Buffer
  try {
    buf = Buffer.from(b64, 'base64')
  } catch {
    return false
  }
  // OpenSSH wire format: uint32 length-prefixed algorithm name comes first.
  if (buf.length < 4) return false
  const nameLen = buf.readUInt32BE(0)
  const NAME = 'ssh-ed25519'
  if (nameLen !== NAME.length || buf.length < 4 + nameLen) return false
  return buf.subarray(4, 4 + nameLen).toString('ascii') === NAME
}

/** Collapse a public-key line to the single trimmed line we append to authorized_keys. */
export function normalizeAuthorizedKeysLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/** Minimal shape of `os.networkInterfaces()` we need — kept structural so tests can fake it. */
export interface NetInterfaceAddr {
  address: string
  family: string | number
  internal: boolean
}

/**
 * Pick a usable LAN IPv4 from `os.networkInterfaces()`, skipping internal (loopback) and
 * link-local (169.254.x.x) addresses. Returns null when none is present.
 */
export function pickLanIPv4(
  interfaces: Record<string, NetInterfaceAddr[] | undefined>
): string | null {
  for (const addrs of Object.values(interfaces)) {
    if (!addrs) continue
    for (const a of addrs) {
      const isV4 = a.family === 'IPv4' || a.family === 4
      if (!isV4 || a.internal) continue
      if (a.address.startsWith('169.254.')) continue
      return a.address
    }
  }
  return null
}
