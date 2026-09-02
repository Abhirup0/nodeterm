/**
 * Shrinking a picked icon image before it is written into the project.
 *
 * An icon draws at 13–16 px. What the picker copied was whatever the user chose — routinely a
 * 4 MB phone photo — and that file went into the project's git-shared `.nodeterm/images/`, so it
 * was committed, cloned by everyone on the repo, and held in renderer memory by
 * `nodeIconImage`'s cache for the life of the session. Nobody ever saw more than 16 px of it.
 *
 * The bound is 256 px on the long edge: 16× the drawn size, so it still looks right on a HiDPI
 * display and if icons ever get bigger, while turning that 4 MB photo into tens of kilobytes.
 *
 * **Split in two on purpose.** `thumbnailPlan` is the whole DECISION and is pure, so it runs under
 * vitest's default `node` environment — jsdom has no canvas, and a rule that could only be tested
 * in a browser would not be tested. `downscaleIconImage` is the part that must touch one, and its
 * decode/encode is injected.
 *
 * **It fails open, always.** Any failure — a decode error, a canvas the browser would not give us,
 * a re-encode that came out larger — yields the ORIGINAL bytes. Losing the user's pick to save
 * some disk is a bad trade; storing a big file is merely the status quo. That includes a decode
 * that never settles AT ALL (`DECODE_TIMEOUT_MS`): `chooseImage` awaits this before it writes, so
 * a promise that hangs would leave the button stuck on "Copying…" with no way out but closing the
 * dialog. A bounded wait turns the worst case back into "the icon is just the file you picked".
 */
import { iconFileName, nodeIconMime } from '@shared/node-icon'

/**
 * How long to wait for a decode before giving up and keeping the original. Decoding a local data
 * URL is near-instant, so this is not a budget — it is a backstop against a decoder that never
 * calls back at all.
 */
export const DECODE_TIMEOUT_MS = 3_000

/** Long-edge bound, in pixels. See the module comment for why 256. */
export const ICON_MAX_EDGE = 256

/**
 * Below this, re-encoding is not worth attempting. A hand-made 32 px PNG or a small favicon is
 * already smaller than anything we would produce, and a canvas round-trip could easily make it
 * BIGGER (it re-encodes at default quality, and it flattens any format cleverness the original
 * had). Sized so an ordinary icon file passes straight through untouched.
 */
export const ICON_SKIP_BYTES = 32 * 1024

/** What `downscaleIconImage` should do with a picked image. */
export type ThumbnailPlan =
  | { downscale: false; reason: 'vector' | 'already-small' | 'unsupported' }
  | { downscale: true; width: number; height: number; name: string }

export interface ThumbnailInput {
  /** The MIME type of the picked file, as `nodeIconMime` answered it. */
  mime: string | undefined
  width: number
  height: number
  /** Decoded size of the picked file, in bytes. */
  byteLength: number
  /** The picked file's name, in either path dialect. */
  name: string
}

/**
 * Decide whether a picked image is worth shrinking, and to what.
 *
 * SVG is passed through untouched: it is already resolution-independent and tiny, and
 * rasterizing it to 256 px would make it *worse* at every size — a smaller file that looks blurry
 * when a future canvas draws icons larger. It is the one format where the original is strictly
 * the better artifact.
 */
export function thumbnailPlan(input: ThumbnailInput): ThumbnailPlan {
  const { mime, width, height, byteLength, name } = input
  if (!mime) return { downscale: false, reason: 'unsupported' }
  if (mime === 'image/svg+xml') return { downscale: false, reason: 'vector' }
  // A zero dimension means the decoder could not tell us anything useful; treat it as "leave it
  // alone" rather than scaling against a number we do not trust.
  if (width <= 0 || height <= 0) return { downscale: false, reason: 'unsupported' }

  const longEdge = Math.max(width, height)
  if (longEdge <= ICON_MAX_EDGE && byteLength <= ICON_SKIP_BYTES) {
    return { downscale: false, reason: 'already-small' }
  }

  // Aspect ratio is preserved; a non-square icon stays non-square. `Math.round` with a floor of 1
  // so an extreme banner (2000x3) cannot produce a zero-height canvas.
  const scale = Math.min(1, ICON_MAX_EDGE / longEdge)
  return {
    downscale: true,
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    // The re-encode is PNG whatever went in, so the name has to say so — a file called `photo.jpg`
    // holding PNG bytes would be read back through `nodeIconMime` as `image/jpeg` and handed to an
    // `<img>` with the wrong data URL type.
    name: `${stripExtension(iconFileName(name)) || 'icon'}.png`
  }
}

/** `logo.jpeg` → `logo`. A name with no dot is returned whole. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

export interface ThumbnailImage {
  width: number
  height: number
}

/** The browser work, injected so the caller can be tested without one. */
export interface ThumbnailDeps {
  /** Decode a data URL into something drawable. Rejects if the bytes are not an image. */
  decode(dataUrl: string): Promise<ThumbnailImage>
  /** Draw `image` at `width`x`height` and return a `image/png` data URL. */
  encode(image: ThumbnailImage, width: number, height: number): string
}

export interface PickedImage {
  /** Base64 (no data-URL prefix), as `fs.readBinary` returns it. */
  base64: string
  name: string
}

/**
 * Shrink `picked` if it is worth shrinking. Returns the bytes and name to save — the ORIGINAL
 * ones whenever the plan says no, or anything at all goes wrong.
 */
export async function downscaleIconImage(
  picked: PickedImage,
  deps: ThumbnailDeps
): Promise<PickedImage> {
  const mime = nodeIconMime(picked.name)
  if (!mime || mime === 'image/svg+xml') return picked
  try {
    const image = await withTimeout(deps.decode(`data:${mime};base64,${picked.base64}`))
    const plan = thumbnailPlan({
      mime,
      width: image.width,
      height: image.height,
      // base64 carries 3 bytes per 4 characters; padding makes this a slight over-estimate, which
      // is the harmless direction (it can only make us try to shrink something borderline).
      byteLength: Math.floor((picked.base64.length * 3) / 4),
      name: picked.name
    })
    if (!plan.downscale) return picked

    const dataUrl = deps.encode(image, plan.width, plan.height)
    const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
    if (!base64) return picked
    // A re-encode that came out LARGER is not an improvement, and it would cost the user their
    // original file for nothing. Screenshots of flat UI hit this: PNG-of-a-PNG at a smaller size
    // is usually smaller, but not always.
    if (base64.length >= picked.base64.length) return picked
    return { base64, name: plan.name }
  } catch {
    return picked
  }
}

/** Reject rather than hang. The rejection lands in `downscaleIconImage`'s catch, i.e. the
 *  original bytes — the same outcome as any other decode failure. */
function withTimeout(p: Promise<ThumbnailImage>): Promise<ThumbnailImage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('decode timed out')), DECODE_TIMEOUT_MS)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

/**
 * The real browser implementation. Kept beside the pure logic rather than inline in the picker so
 * the seam is obvious, and so a second caller (a future project-icon picker, say) reuses it.
 */
export const browserThumbnailDeps: ThumbnailDeps = {
  decode: (dataUrl) =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('decode failed'))
      img.src = dataUrl
    }),
  encode: (image, width, height) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('no 2d context')
    ctx.drawImage(image as CanvasImageSource, 0, 0, width, height)
    return canvas.toDataURL('image/png')
  }
}
