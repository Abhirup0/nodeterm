// Pure PCM wire-encoder for the browser (Server Edition) speech bridge.
//
// The bridge cannot import `src/core` (it's the Electron-free service core, and the browser
// build must not pull it in either — see `src/core/no-electron.test.ts`'s sibling rule for the
// bridge). So this duplicates the ws-wire half of `src/core/speech/pcm.ts`'s float32<->int16
// convention (documented there: "Electron IPC carries raw Float32 ArrayBuffers, the ws bridge
// carries base64 int16 — half the bytes over JSON") rather than importing it. Keep the two in
// sync if the encoding ever changes; `decodePcmPayload` on the receiving end is the source of
// truth for the wire format.

/** Encode Float32 PCM samples ([-1, 1]) as base64 of little-endian Int16 samples — the format
 *  `decodePcmPayload` (src/core/speech/pcm.ts) expects for the string branch of its payload.
 *
 *  Uses `btoa`, not Node's `Buffer` — this file runs in the browser (Server Edition), which has
 *  no `Buffer` global. */
export function encodePcmForWire(pcm: Float32Array): string {
  const out = new Int16Array(pcm.length)
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]))
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767)
  }
  // Typed arrays use the platform's native byte order, which is little-endian on every commodity
  // CPU (and thus every desktop/browser build target) — no DataView byte-swap needed.
  const bytes = new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  // btoa() takes a binary string. String.fromCharCode.apply has an argument-count ceiling (~64k)
  // on some engines, so build it in chunks rather than spreading the whole array at once.
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}
