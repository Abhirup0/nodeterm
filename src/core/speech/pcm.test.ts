import { describe, expect, it } from 'vitest'
import { pcmToWav, float32ToInt16, int16ToFloat32, decodePcmPayload } from './pcm'

describe('pcm helpers', () => {
  it('writes a valid 16-bit mono WAV header', () => {
    const wav = pcmToWav(new Float32Array([0, 0.5, -0.5, 1]), 16000)
    const dv = new DataView(wav.buffer, wav.byteOffset)
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...wav.subarray(8, 12))).toBe('WAVE')
    expect(dv.getUint16(22, true)).toBe(1) // mono
    expect(dv.getUint32(24, true)).toBe(16000) // sample rate
    expect(dv.getUint16(34, true)).toBe(16) // bits per sample
    expect(dv.getUint32(40, true)).toBe(8) // data bytes: 4 samples * 2
    expect(wav.length).toBe(44 + 8)
  })

  it('round-trips float32 ↔ int16 with clamping', () => {
    const src = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5])
    const i16 = float32ToInt16(src)
    expect(i16[5]).toBe(32767) // clamped
    expect(i16[6]).toBe(-32768)
    const back = int16ToFloat32(i16)
    expect(back[1]).toBeCloseTo(0.5, 2)
    expect(back[3]).toBeCloseTo(1, 2)
  })

  it('decodes both payload encodings to the same audio', () => {
    const src = new Float32Array([0.25, -0.25, 0.75])
    const fromBuffer = decodePcmPayload(src.buffer.slice(0))
    expect(Array.from(fromBuffer)).toEqual(Array.from(src))
    const b64 = Buffer.from(float32ToInt16(src).buffer).toString('base64')
    const fromB64 = decodePcmPayload(b64)
    expect(fromB64[0]).toBeCloseTo(0.25, 2)
    expect(fromB64[1]).toBeCloseTo(-0.25, 2)
    expect(fromB64[2]).toBeCloseTo(0.75, 2)
  })
})
