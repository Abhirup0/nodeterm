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
