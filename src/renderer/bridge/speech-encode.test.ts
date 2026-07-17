import { describe, expect, it } from 'vitest'
import { encodePcmForWire } from './speech-encode'

describe('encodePcmForWire', () => {
  it('emits base64 int16 little-endian', () => {
    const b64 = encodePcmForWire(new Float32Array([0, 1, -1]))
    const raw = Buffer.from(b64, 'base64')
    const i16 = new Int16Array(raw.buffer, raw.byteOffset, 3)
    expect(Array.from(i16)).toEqual([0, 32767, -32768])
  })
})
