import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { ICNS_FRAMES, packIcns } from '../../scripts/icon-pack.mjs'

// Issue #369: the shipped icon.icns (derived by electron-builder from build/icon.png) carried
// WRONG-SIZED payloads — ic13 (nominally 128pt@2x = 256px) held the 512px PNG and ic14 (256pt@2x
// = 512px) held the 1024px one. A consumer that trusts the TYPE's nominal size and decodes into a
// buffer of that stride renders exactly the rainbow noise the report shows. The fix is packing the
// icns ourselves (as make-icon already does for the Windows .ico), with the packer REFUSING any
// frame whose PNG dimensions disagree with its type.

async function framesFor(table: Array<{ type: string; px: number }>): Promise<Map<string, Buffer>> {
  const frames = new Map<string, Buffer>()
  for (const { type, px } of table) {
    frames.set(
      type,
      await sharp({ create: { width: px, height: px, channels: 4, background: '#7a4bd0' } })
        .png()
        .toBuffer()
    )
  }
  return frames
}

/** Parse an icns container into type → payload. */
function parseIcns(buf: Buffer): Map<string, Buffer> {
  expect(buf.subarray(0, 4).toString('ascii')).toBe('icns')
  expect(buf.readUInt32BE(4)).toBe(buf.byteLength)
  const out = new Map<string, Buffer>()
  let off = 8
  while (off < buf.byteLength) {
    const type = buf.subarray(off, off + 4).toString('ascii')
    const len = buf.readUInt32BE(off + 4)
    out.set(type, buf.subarray(off + 8, off + len))
    off += len
  }
  return out
}

const pngSize = (png: Buffer) => ({ w: png.readUInt32BE(16), h: png.readUInt32BE(20) })

describe('ICNS_FRAMES', () => {
  it("is Apple's iconutil table — every type carries its own pixel size, retina types included", () => {
    expect(Object.fromEntries(ICNS_FRAMES.map((f) => [f.type, f.px]))).toEqual({
      icp4: 16,
      icp5: 32,
      ic07: 128,
      ic08: 256,
      ic09: 512,
      ic10: 1024,
      ic11: 32,
      ic12: 64,
      ic13: 256,
      ic14: 512
    })
  })
})

describe('packIcns', () => {
  it('packs a valid container whose every payload matches its type\'s nominal size', async () => {
    const frames = await framesFor(ICNS_FRAMES)
    const parsed = parseIcns(packIcns(frames))
    expect([...parsed.keys()].sort()).toEqual(ICNS_FRAMES.map((f) => f.type).sort())
    for (const { type, px } of ICNS_FRAMES) {
      const payload = parsed.get(type)!
      expect(payload.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      expect(pngSize(payload)).toEqual({ w: px, h: px })
    }
  })

  it('REFUSES a frame whose PNG dimensions disagree with its type (the shipped ic13/ic14 bug)', async () => {
    const frames = await framesFor(ICNS_FRAMES)
    frames.set(
      'ic13',
      await sharp({ create: { width: 512, height: 512, channels: 4, background: '#000' } })
        .png()
        .toBuffer()
    )
    expect(() => packIcns(frames)).toThrow(/ic13.*256.*512/)
  })

  it('REFUSES a missing frame — every type in the table must be present', async () => {
    const frames = await framesFor(ICNS_FRAMES)
    frames.delete('icp5')
    expect(() => packIcns(frames)).toThrow(/icp5/)
  })
})
