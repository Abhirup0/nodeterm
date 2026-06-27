// Pairing-offer codec for the relay transport.
//
// Encodes/decodes the `nodeterm://pair` offer. Pure functions: no sockets, no
// Electron, and no zod — validation is hand-rolled so decode never throws
// (returns null instead).

export type PairingOffer = {
  // The relay WebSocket endpoint the client connects to.
  relayEndpoint: string
  // Single-use token authorizing this pairing on the relay.
  pairingToken: string
  // The host's Curve25519 public key, base64-encoded. The client uses this to
  // derive the shared secret via ECDH for end-to-end encryption.
  hostPublicKeyB64: string
}

const SCHEME_PREFIX = 'nodeterm://pair?code='

export function encodeOffer(offer: PairingOffer): string {
  const json = JSON.stringify(offer)
  const code = Buffer.from(json, 'utf-8').toString('base64url')
  // Why: query params survive custom-scheme deep links / camera intents more
  // reliably than URL fragments.
  return `${SCHEME_PREFIX}${code}`
}

// Decode either a full `nodeterm://pair?code=…` URL or a bare base64url code.
// Returns null on any malformed / incomplete input — never throws.
export function decodeOffer(code: string): PairingOffer | null {
  const trimmed = code.trim()
  if (!trimmed) {
    return null
  }
  const raw = extractCode(trimmed)
  if (raw === null) {
    return null
  }
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf-8')
    const parsed = JSON.parse(json) as unknown
    return isPairingOffer(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Pull the base64url code out of a `nodeterm://pair?code=…` URL, or treat the
// input as a bare code if it carries no scheme.
function extractCode(input: string): string | null {
  if (input.includes('://')) {
    let parsed: URL
    try {
      parsed = new URL(input)
    } catch {
      return null
    }
    if (parsed.protocol !== 'nodeterm:' || parsed.hostname !== 'pair') {
      return null
    }
    if (parsed.pathname !== '' && parsed.pathname !== '/') {
      return null
    }
    return parsed.searchParams.get('code')
  }
  return input
}

function isPairingOffer(value: unknown): value is PairingOffer {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const o = value as Record<string, unknown>
  return (
    typeof o.relayEndpoint === 'string' &&
    o.relayEndpoint.length > 0 &&
    typeof o.pairingToken === 'string' &&
    o.pairingToken.length > 0 &&
    typeof o.hostPublicKeyB64 === 'string' &&
    o.hostPublicKeyB64.length > 0
  )
}
