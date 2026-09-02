// The decision half runs here under the default `node` environment — no jsdom, no canvas. That
// is the reason the module is split: a rule that could only be exercised in a browser would not
// be exercised at all.
import { describe, expect, it, vi } from 'vitest'
import {
  DECODE_TIMEOUT_MS,
  downscaleIconImage,
  ICON_MAX_EDGE,
  ICON_SKIP_BYTES,
  thumbnailPlan,
  type ThumbnailDeps
} from './nodeIconThumbnail'

const BIG = 200 * 1024

describe('thumbnailPlan', () => {
  it('shrinks a large photo to the long-edge bound, keeping its aspect ratio', () => {
    const plan = thumbnailPlan({
      mime: 'image/jpeg',
      width: 4000,
      height: 3000,
      byteLength: 4_000_000,
      name: 'photo.jpg'
    })
    expect(plan).toEqual({
      downscale: true,
      width: ICON_MAX_EDGE,
      height: 192, // 3000 * (256/4000)
      name: 'photo.png'
    })
  })

  it('renames to .png, because the re-encode IS png whatever went in', () => {
    // A file called `photo.jpg` holding PNG bytes reads back through `nodeIconMime` as
    // image/jpeg, and the data URL would then declare the wrong type.
    const plan = thumbnailPlan({
      mime: 'image/jpeg',
      width: 2000,
      height: 2000,
      byteLength: BIG,
      name: 'C:\\Users\\me\\photo.JPEG'
    })
    expect(plan).toMatchObject({ downscale: true, name: 'photo.png' })
  })

  it('leaves SVG alone — the original is strictly the better artifact', () => {
    // Rasterizing it to 256px would make it WORSE at every size, not just bigger-file-worse.
    expect(
      thumbnailPlan({
        mime: 'image/svg+xml',
        width: 4000,
        height: 4000,
        byteLength: 4_000_000,
        name: 'mark.svg'
      })
    ).toEqual({ downscale: false, reason: 'vector' })
  })

  it('leaves an already-small icon alone, so a hand-made 32px PNG is untouched', () => {
    expect(
      thumbnailPlan({ mime: 'image/png', width: 32, height: 32, byteLength: 900, name: 'a.png' })
    ).toEqual({ downscale: false, reason: 'already-small' })
  })

  it('still shrinks small DIMENSIONS carrying big BYTES (an animated gif)', () => {
    const plan = thumbnailPlan({
      mime: 'image/gif',
      width: 64,
      height: 64,
      byteLength: ICON_SKIP_BYTES + 1,
      name: 'spin.gif'
    })
    // Under the edge bound, so it is not scaled DOWN — but it is re-encoded, which is what drops
    // the frames nobody can see at 16px.
    expect(plan).toEqual({ downscale: true, width: 64, height: 64, name: 'spin.png' })
  })

  it('refuses to scale against a dimension it does not trust', () => {
    expect(
      thumbnailPlan({ mime: 'image/png', width: 0, height: 0, byteLength: BIG, name: 'a.png' })
    ).toEqual({ downscale: false, reason: 'unsupported' })
  })

  it('never produces a zero edge for an extreme banner', () => {
    const plan = thumbnailPlan({
      mime: 'image/png',
      width: 2000,
      height: 3,
      byteLength: BIG,
      name: 'bar.png'
    })
    expect(plan).toMatchObject({ downscale: true, width: ICON_MAX_EDGE, height: 1 })
  })
})

/** A deps double: decodes to fixed dimensions, encodes to a data URL of a chosen size. */
const deps = (dim: { width: number; height: number }, encodedChars: number): ThumbnailDeps => ({
  decode: vi.fn(async () => dim),
  encode: vi.fn(() => `data:image/png;base64,${'x'.repeat(encodedChars)}`)
})

describe('downscaleIconImage', () => {
  const picked = { base64: 'y'.repeat(400_000), name: 'photo.jpg' }

  it('returns the shrunk bytes and the .png name', async () => {
    const d = deps({ width: 4000, height: 3000 }, 5_000)
    const out = await downscaleIconImage(picked, d)
    expect(out.name).toBe('photo.png')
    expect(out.base64).toHaveLength(5_000)
    expect(d.encode).toHaveBeenCalledWith({ width: 4000, height: 3000 }, ICON_MAX_EDGE, 192)
  })

  it('keeps the ORIGINAL when the re-encode came out larger', async () => {
    const out = await downscaleIconImage(picked, deps({ width: 4000, height: 3000 }, 999_999))
    expect(out).toBe(picked)
  })

  it('keeps the ORIGINAL when decoding throws — a failure must not cost the user their pick', async () => {
    const out = await downscaleIconImage(picked, {
      decode: async () => {
        throw new Error('not an image')
      },
      encode: () => 'data:image/png;base64,zzz'
    })
    expect(out).toBe(picked)
  })

  it('keeps the ORIGINAL when there is no canvas to draw on', async () => {
    const out = await downscaleIconImage(picked, {
      decode: async () => ({ width: 4000, height: 3000 }),
      encode: () => {
        throw new Error('no 2d context')
      }
    })
    expect(out).toBe(picked)
  })

  it('never touches an SVG, without even decoding it', async () => {
    const svg = { base64: 'PHN2Zz48L3N2Zz4=', name: 'mark.svg' }
    const d = deps({ width: 4000, height: 4000 }, 10)
    expect(await downscaleIconImage(svg, d)).toBe(svg)
    expect(d.decode).not.toHaveBeenCalled()
  })

  it('keeps the ORIGINAL when the decode never settles at all', async () => {
    // `chooseImage` awaits this before it writes, so a hanging promise would leave the button
    // stuck on "Copying…" with no way out but closing the dialog.
    vi.useFakeTimers()
    try {
      const pending = downscaleIconImage(picked, {
        decode: () => new Promise<never>(() => {}),
        encode: () => 'data:image/png;base64,zzz'
      })
      await vi.advanceTimersByTimeAsync(DECODE_TIMEOUT_MS + 1)
      expect(await pending).toBe(picked)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never touches a file whose extension is not an icon type', async () => {
    const other = { base64: 'zzzz', name: 'photo.heic' }
    const d = deps({ width: 4000, height: 4000 }, 10)
    expect(await downscaleIconImage(other, d)).toBe(other)
    expect(d.decode).not.toHaveBeenCalled()
  })
})
