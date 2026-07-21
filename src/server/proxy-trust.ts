// Reverse-proxy SSO header trust (issue #29, Option B).
//
// A deployment that fronts the Server Edition with an SSO reverse proxy (Cloudflare
// Access, Tailscale, oauth2-proxy…) already authenticates every request; the proxy
// asserts the identity in a request header. When configured, a request is treated as
// authenticated iff its TCP peer address is inside the trusted networks AND it carries
// the configured header with a non-empty value. The header CONTENT is deliberately not
// validated (no JWT verification): the trusted-network boundary is the trust statement —
// only the proxy can be the TCP peer, and the proxy owns setting/stripping the header.
// Everything here is pure (no node:http import) so it unit-tests without sockets.

export interface TrustedNet {
  /** 4 bytes (IPv4) or 16 bytes (IPv6). */
  bytes: Uint8Array
  prefix: number
}

export interface TrustProxyConfig {
  /** Header name asserting the authenticated identity, e.g. Cf-Access-Authenticated-User-Email. */
  header: string
  nets: TrustedNet[]
}

/** Default trusted networks: loopback only — the recommended same-host proxy deployment. */
export const DEFAULT_TRUSTED_NETS_SPEC = '127.0.0.0/8, ::1/128'

function parseIPv4(s: string): Uint8Array | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out = new Uint8Array(4)
  for (let i = 0; i < 4; i++) {
    if (!/^\d{1,3}$/.test(parts[i])) return null
    const n = Number(parts[i])
    if (n > 255) return null
    out[i] = n
  }
  return out
}

function parseIPv6(s: string): Uint8Array | null {
  // Handle a trailing IPv4 tail (::ffff:1.2.3.4) by converting it to two hex groups.
  const v4Tail = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (v4Tail) {
    const v4 = parseIPv4(v4Tail[2])
    if (!v4) return null
    const hi = ((v4[0] << 8) | v4[1]).toString(16)
    const lo = ((v4[2] << 8) | v4[3]).toString(16)
    s = v4Tail[1] + hi + ':' + lo
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const groups = (part: string): string[] => (part === '' ? [] : part.split(':'))
  const head = groups(halves[0])
  const tail = halves.length === 2 ? groups(halves[1]) : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...tail]
  const out = new Uint8Array(16)
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(all[i])) return null
    const n = parseInt(all[i], 16)
    out[i * 2] = n >> 8
    out[i * 2 + 1] = n & 0xff
  }
  return out
}

function parseAddress(s: string): Uint8Array | null {
  return s.includes(':') ? parseIPv6(s) : parseIPv4(s)
}

/**
 * Parse a comma-separated list of IPs / CIDRs (IPv4 + IPv6) into trusted nets.
 * Throws on any unparseable entry: a typo in the trust config must fail the boot,
 * not silently narrow (or widen) trust.
 */
export function parseTrustedNets(spec: string): TrustedNet[] {
  const entries = spec
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '')
  if (entries.length === 0) throw new Error('trusted-nets list is empty')
  return entries.map((entry) => {
    const slash = entry.indexOf('/')
    const addrPart = slash === -1 ? entry : entry.slice(0, slash)
    const bytes = parseAddress(addrPart)
    if (!bytes) throw new Error(`unparseable trusted-net entry "${entry}"`)
    const maxPrefix = bytes.length * 8
    let prefix = maxPrefix
    if (slash !== -1) {
      const p = entry.slice(slash + 1)
      if (!/^\d{1,3}$/.test(p) || Number(p) > maxPrefix) {
        throw new Error(`unparseable trusted-net entry "${entry}"`)
      }
      prefix = Number(p)
    }
    return { bytes, prefix }
  })
}

/** Collapse an IPv4-mapped IPv6 address (::ffff:a.b.c.d) to its 4-byte IPv4 form. */
function normalize(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 16) return bytes
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return bytes
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return bytes
  return bytes.slice(12)
}

function matchesNet(addr: Uint8Array, net: TrustedNet): boolean {
  if (addr.length !== net.bytes.length) return false
  const fullBytes = net.prefix >> 3
  for (let i = 0; i < fullBytes; i++) if (addr[i] !== net.bytes[i]) return false
  const rem = net.prefix & 7
  if (rem === 0) return true
  const mask = (0xff << (8 - rem)) & 0xff
  return (addr[fullBytes] & mask) === (net.bytes[fullBytes] & mask)
}

/** Human-readable form of the parsed nets for the boot-time warning log. */
export function describeTrustedNets(nets: TrustedNet[]): string {
  return nets
    .map((net) => {
      if (net.bytes.length === 4) return `${Array.from(net.bytes).join('.')}/${net.prefix}`
      const groups: string[] = []
      for (let i = 0; i < 16; i += 2) {
        groups.push(((net.bytes[i] << 8) | net.bytes[i + 1]).toString(16))
      }
      return `${groups.join(':')}/${net.prefix}`
    })
    .join(', ')
}

/** Is this socket peer address inside any of the trusted nets? Garbage/missing → false. */
export function isTrustedAddress(addr: string | undefined, nets: TrustedNet[]): boolean {
  if (!addr) return false
  const parsed = parseAddress(addr)
  if (!parsed) return false
  const norm = normalize(parsed)
  return nets.some((net) => matchesNet(norm, net))
}

/**
 * The one auth decision: trusted peer + configured header present with a non-empty value.
 * `headers` is Node's lowercased header map; a repeated header (array value) is ambiguous
 * and rejected — fail closed.
 */
export function proxyAuthAllowed(
  trust: TrustProxyConfig,
  headers: Record<string, string | string[] | undefined>,
  remoteAddress: string | undefined
): boolean {
  if (!isTrustedAddress(remoteAddress, trust.nets)) return false
  const value = headers[trust.header.toLowerCase()]
  return typeof value === 'string' && value.trim() !== ''
}
