import { describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { PROJECT_ICON_MAX_BYTES } from '@shared/project-icon'
import { encodeProjectIconImage } from './project-icon-upload'

/** A solid-colour PNG of the given size — a stand-in for a user-chosen file. */
async function png(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } }
  })
    .png()
    .toBuffer()
}

describe('encodeProjectIconImage (sharp-bound)', () => {
  it('re-encodes a real image to a PNG data URL', async () => {
    const out = await encodeProjectIconImage(await png(300, 200))
    expect('dataUrl' in out).toBe(true)
    if (!('dataUrl' in out)) return
    expect(out.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('bounds the longest edge to 128px, preserving aspect ratio', async () => {
    const out = await encodeProjectIconImage(await png(512, 256))
    if (!('dataUrl' in out)) throw new Error('expected a dataUrl')
    const base64 = out.dataUrl.slice(out.dataUrl.indexOf(',') + 1)
    const meta = await sharp(Buffer.from(base64, 'base64')).metadata()
    expect(meta.width).toBe(128)
    expect(meta.height).toBe(64)
  })

  it('does not enlarge a source already under the bound', async () => {
    const out = await encodeProjectIconImage(await png(40, 40))
    if (!('dataUrl' in out)) throw new Error('expected a dataUrl')
    const base64 = out.dataUrl.slice(out.dataUrl.indexOf(',') + 1)
    const meta = await sharp(Buffer.from(base64, 'base64')).metadata()
    expect(meta.width).toBe(40)
    expect(meta.height).toBe(40)
  })

  it('rejects with an error when the encoded image exceeds the byte cap', async () => {
    // A 128px PNG is always well under 256 KB in practice, so force the cap tiny to exercise the
    // guard: the SAME arithmetic (dataUrlByteLength) that sanitizeProjectIcon re-checks on load.
    const out = await encodeProjectIconImage(await png(128, 128), 100)
    expect('error' in out).toBe(true)
    if ('error' in out) expect(out.error).toMatch(/too large/i)
  })

  it('surfaces an error (never throws) for a buffer that is not an image', async () => {
    const out = await encodeProjectIconImage(Buffer.from('not an image at all'))
    expect('error' in out).toBe(true)
  })

  it('a normally-encoded icon is within the real cap', async () => {
    const out = await encodeProjectIconImage(await png(128, 128), PROJECT_ICON_MAX_BYTES)
    expect('dataUrl' in out).toBe(true)
  })
})
