/** WS-RPC protocol for the Server Edition bridge (spec: docs/superpowers/specs/
 *  2026-07-10-server-edition-design.md). JSON text frames for requests/responses/
 *  events; binary frames only for high-volume pty output. Isomorphic: runs in the
 *  browser bridge and the node server. */

export type RpcRequest = { t: 'req'; id: number; method: string; args: unknown[] }
export type RpcCast = { t: 'cast'; method: string; args: unknown[] }
export type RpcOk = { t: 'res'; id: number; ok: true; result: unknown }
export type RpcErr = { t: 'res'; id: number; ok: false; error: { code: string; message: string } }
export type RpcEvent = { t: 'ev'; channel: string; args: unknown[] }
export type RpcMessage = RpcRequest | RpcCast | RpcOk | RpcErr | RpcEvent

export const E_UNSUPPORTED = 'E_UNSUPPORTED'
export const E_UNAUTHORIZED = 'E_UNAUTHORIZED'
export const E_NO_HANDLER = 'E_NO_HANDLER'
/** The socket closed with requests still in flight — they can never be answered. Client-side only:
 *  no server ever sends this, the client synthesises it so an `await` fails instead of hanging. */
export const E_DISCONNECTED = 'E_DISCONNECTED'

/**
 * Undo JSON's `undefined` → `null` mangling on the TOP-LEVEL argument slots.
 *
 * `JSON.stringify([a, undefined])` is `[a, null]`: the wire has no `undefined`. So a caller that
 * simply omits a trailing optional argument (`git.history(cwd)`, `worktreeMerge(repo, b, base)`)
 * hands the handler an explicit `null` — and an explicit `null` does NOT trigger a default
 * parameter. `worktreeMerge(…, push = false)` would run with `push === null`.
 *
 * Every such default in the API today is falsy (`push = false`, `pruneOnly = false`, `full = false`),
 * so `null` coerces to the same behavior and nothing breaks — safe BY LUCK. The first `= true`
 * default, or any handler that tests `arg === undefined`, silently reintroduces the bug (`git.history`
 * already broke this way once). Restoring `undefined` here fixes it for every handler at once,
 * instead of asking each new one to remember.
 *
 * Only the top-level slots are touched: a `null` nested inside an object or array is data the sender
 * genuinely meant to send (`{cwd: null}` is not `{}`), and no method in the preload API surface takes
 * a meaningful top-level `null` — which is what makes the substitution safe. Arity is preserved: the
 * slot stays, it just holds `undefined` again.
 */
const decodeArgs = (args: unknown[]): unknown[] => args.map((a) => (a === null ? undefined : a))

export function parseRpcMessage(text: string): RpcMessage | null {
  let m: unknown
  try {
    m = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof m !== 'object' || m === null) return null
  const o = m as Record<string, unknown>
  switch (o.t) {
    case 'req':
      if (typeof o.id === 'number' && typeof o.method === 'string' && Array.isArray(o.args))
        return { ...(o as RpcRequest), args: decodeArgs(o.args) }
      return null
    case 'cast':
      if (typeof o.method === 'string' && Array.isArray(o.args))
        return { ...(o as RpcCast), args: decodeArgs(o.args) }
      return null
    case 'res':
      if (typeof o.id !== 'number') return null
      if (o.ok === true) return o as RpcOk
      if (o.ok === false && typeof o.error === 'object' && o.error !== null) return o as RpcErr
      return null
    case 'ev':
      if (typeof o.channel === 'string' && Array.isArray(o.args))
        return { ...(o as RpcEvent), args: decodeArgs(o.args) }
      return null
    default:
      return null
  }
}

const PTY_DATA_FRAME = 0x01
const enc = new TextEncoder()
const dec = new TextDecoder()

export function encodePtyData(sessionId: string, data: string): Uint8Array {
  const sid = enc.encode(sessionId)
  const payload = enc.encode(data)
  const buf = new Uint8Array(3 + sid.length + payload.length)
  buf[0] = PTY_DATA_FRAME
  buf[1] = (sid.length >> 8) & 0xff
  buf[2] = sid.length & 0xff
  buf.set(sid, 3)
  buf.set(payload, 3 + sid.length)
  return buf
}

export function decodePtyData(buf: Uint8Array): { sessionId: string; data: string } | null {
  if (buf.length < 3 || buf[0] !== PTY_DATA_FRAME) return null
  const sidLen = (buf[1] << 8) | buf[2]
  if (3 + sidLen > buf.length) return null
  return {
    sessionId: dec.decode(buf.subarray(3, 3 + sidLen)),
    data: dec.decode(buf.subarray(3 + sidLen))
  }
}
