/** Pure PCM helpers for the speech pipeline. Two wire encodings exist:
 * Electron IPC carries raw Float32 ArrayBuffers (structured clone), the ws
 * bridge carries base64 int16 (half the bytes over JSON). Both normalize to
 * Float32 here; whisper.cpp consumes Float32 directly and the Cloud engine
 * wraps it into a 16-bit WAV. */

export function float32ToInt16(pcm: Float32Array): Int16Array {
  const out = new Int16Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]))
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767)
  }
  return out
}

export function int16ToFloat32(pcm: Int16Array): Float32Array {
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) out[i] = pcm[i] / (pcm[i] < 0 ? 32768 : 32767)
  return out
}

export function pcmToWav(pcm: Float32Array, sampleRate = 16000): Uint8Array {
  const samples = float32ToInt16(pcm)
  const dataBytes = samples.length * 2
  const out = new Uint8Array(44 + dataBytes)
  const dv = new DataView(out.buffer)
  const ascii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  dv.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  dv.setUint32(16, 16, true) // fmt chunk size
  dv.setUint16(20, 1, true) // PCM
  dv.setUint16(22, 1, true) // mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true) // byte rate
  dv.setUint16(32, 2, true) // block align
  dv.setUint16(34, 16, true) // bits per sample
  ascii(36, 'data')
  dv.setUint32(40, dataBytes, true)
  out.set(new Uint8Array(samples.buffer), 44)
  return out
}

export function decodePcmPayload(payload: ArrayBuffer | string): Float32Array {
  if (typeof payload === 'string') {
    const raw = Buffer.from(payload, 'base64')
    // Copy out of the Buffer pool: a typed-array view over raw.buffer would
    // depend on the pool's (undocumented) alignment — an odd byteOffset makes
    // Int16Array throw. The copy also detaches us from pool reuse.
    const bytes = new Uint8Array(raw.byteLength)
    bytes.set(raw)
    return int16ToFloat32(new Int16Array(bytes.buffer))
  }
  return new Float32Array(payload)
}
