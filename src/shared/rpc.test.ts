import { describe, it, expect } from 'vitest'
import { parseRpcMessage, encodePtyData, decodePtyData } from './rpc'

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

  // `JSON.stringify([a, undefined])` is `[a, null]` — the wire has no `undefined`. So a browser
  // call that omits a trailing optional argument (`git.history(cwd)`, `worktreeMerge(repo, b, base)`)
  // arrives at the handler as an EXPLICIT `null`, which does NOT trigger a default parameter:
  // `worktreeMerge(…, push = false)` runs with `push === null`. Today every such default happens to
  // be falsy, so `null` coerces to the same behavior and the bug is invisible — safe by luck, not by
  // construction. The first `= true` default (or any handler that branches on `arg === undefined`)
  // reintroduces it; `git.history` already broke exactly this way. The decoder is the one place
  // that can close it for every handler at once, so it does: no method in the preload API surface
  // takes a meaningful `null`, which is what makes the substitution safe.
  it('decodes a null argument back to undefined, so default parameters actually apply', () => {
    const req = parseRpcMessage('{"t":"req","id":1,"method":"git:worktree-merge","args":["/repo","feat","main",null]}')
    expect(req).toEqual({
      t: 'req', id: 1, method: 'git:worktree-merge', args: ['/repo', 'feat', 'main', undefined]
    })
    // Arity is preserved (the slot stays), and `undefined` is what makes `push = false` fire.
    const args = (req as { args: unknown[] }).args
    expect(args.length).toBe(4)
    const push = args[3] as boolean | undefined
    expect(((p = false) => p)(push)).toBe(false)

    // Interior nulls too: `[undefined, 2]` serialises to `[null, 2]` just the same.
    expect(parseRpcMessage('{"t":"cast","method":"m","args":[null,2]}')).toEqual({
      t: 'cast', method: 'm', args: [undefined, 2]
    })
    expect(parseRpcMessage('{"t":"ev","channel":"c","args":[null]}')).toEqual({
      t: 'ev', channel: 'c', args: [undefined]
    })
  })

  it('leaves a null NESTED inside an argument alone (only top-level slots are wire artifacts)', () => {
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
