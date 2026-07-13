import { describe, it, expect } from 'vitest'
import { parseRpcMessage, encodeArgs, encodePtyData, decodePtyData } from './rpc'

/** What a sender actually puts on the wire: encode the arg slots, then JSON. */
const wire = (method: string, ...args: unknown[]): string =>
  JSON.stringify({ t: 'cast', method, args: encodeArgs(args) })

describe('rpc protocol', () => {
  it('parses each message kind and rejects malformed input', () => {
    expect(parseRpcMessage('{"t":"req","id":1,"method":"pty:create","args":[{}]}')).toEqual({
      t: 'req', id: 1, method: 'pty:create', args: [{}]
    })
    expect(parseRpcMessage('{"t":"cast","method":"pty:write","args":["s1","ls\\r"]}')).toEqual({
      t: 'cast', method: 'pty:write', args: ['s1', 'ls\r']
    })
    expect(parseRpcMessage('{"t":"res","id":1,"ok":true,"result":42}')).toEqual({
      t: 'res', id: 1, ok: true, result: 42
    })
    expect(parseRpcMessage('{"t":"ev","channel":"pty:exit:s1","args":[0]}')).toEqual({
      t: 'ev', channel: 'pty:exit:s1', args: [0]
    })
    expect(parseRpcMessage('not json')).toBeNull()
    expect(parseRpcMessage('{"t":"nope"}')).toBeNull()
    expect(parseRpcMessage('{"t":"req","id":"x","method":1}')).toBeNull()
  })

  // `JSON.stringify([a, undefined])` is `[a, null]` — raw JSON has no `undefined`. A browser call
  // that omits a trailing optional argument (`git.history(cwd)`, `worktreeMerge(repo, b, base)`)
  // would therefore reach the handler as an EXPLICIT `null`, which does NOT trigger a default
  // parameter: `worktreeMerge(…, push = false)` would run with `push === null` (`git.history` broke
  // exactly this way). `encodeArgs` marks the `undefined` slots explicitly, so the decoder RESTORES
  // them instead of guessing from `null`.
  it('round-trips an omitted trailing argument as undefined, so default parameters apply', () => {
    const req = parseRpcMessage(
      JSON.stringify({
        t: 'req',
        id: 1,
        method: 'git:worktree-merge',
        args: encodeArgs(['/repo', 'feat', 'main', undefined])
      })
    )
    expect(req).toEqual({
      t: 'req', id: 1, method: 'git:worktree-merge', args: ['/repo', 'feat', 'main', undefined]
    })
    // Arity is preserved (the slot stays), and `undefined` is what makes `push = false` fire.
    const args = (req as { args: unknown[] }).args
    expect(args.length).toBe(4)
    const push = args[3] as boolean | undefined
    expect(((p = false) => p)(push)).toBe(false)

    // Interior undefined slots survive too.
    expect(parseRpcMessage(wire('m', undefined, 2))).toEqual({
      t: 'cast', method: 'm', args: [undefined, 2]
    })
  })

  // The counterpart, and the reason the old blanket `null → undefined` decode was a BUG: several
  // methods take a MEANINGFUL top-level `null` — `pty.resize(sid, null, null)` is the co-attach
  // "park" signal (drop me from the size ledger), `presence.cursor/focus/chat/project(null)` clear
  // state, `git.setActiveRemote(null)` clears the remote. Rewriting those to `undefined` collapsed
  // the shared pty to 1×1 (the strict `cols === null` park check missed, and `normalizeSize(
  // undefined, undefined)` clamps to 1). A null the caller MEANT must arrive as null.
  it('preserves a meaningful top-level null (park signal / clear-state casts)', () => {
    expect(parseRpcMessage(wire('pty:resize', 's1', null, null))).toEqual({
      t: 'cast', method: 'pty:resize', args: ['s1', null, null]
    })
    expect(parseRpcMessage(wire('presence:cursor', null))).toEqual({
      t: 'cast', method: 'presence:cursor', args: [null]
    })
    // …and a null and an omitted slot are distinguishable in the SAME call.
    expect(parseRpcMessage(wire('m', null, undefined))).toEqual({
      t: 'cast', method: 'm', args: [null, undefined]
    })
  })

  it('leaves a null NESTED inside an argument alone (encoding only marks top-level slots)', () => {
    // A null inside an object/array is real data the sender meant to send — `{cwd: null}` is not the
    // same as `{}` to a handler that checks `'cwd' in opts`. Only the top-level arg slots are the
    // ones JSON mangled, so only those are restored.
    expect(parseRpcMessage('{"t":"req","id":2,"method":"m","args":[{"cwd":null},[null]]}')).toEqual({
      t: 'req', id: 2, method: 'm', args: [{ cwd: null }, [null]]
    })
  })

  it('round-trips pty data through the binary codec (incl. multibyte)', () => {
    const buf = encodePtyData('nt-abc', 'çıktı ✓[31m')
    expect(buf[0]).toBe(0x01)
    expect(decodePtyData(buf)).toEqual({ sessionId: 'nt-abc', data: 'çıktı ✓[31m' })
  })

  it('decode returns null on truncated or unknown frames', () => {
    expect(decodePtyData(new Uint8Array([0x02, 0, 1, 65]))).toBeNull()
    expect(decodePtyData(new Uint8Array([0x01, 0, 9, 65]))).toBeNull() // len beyond buffer
    expect(decodePtyData(new Uint8Array([]))).toBeNull()
  })
})
