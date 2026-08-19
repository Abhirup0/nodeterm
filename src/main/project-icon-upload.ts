import { promises as fsp } from 'node:fs'
import sharp from 'sharp'
import {
  dataUrlByteLength,
  PROJECT_ICON_MAX_BYTES,
  type ProjectIconPickResult
} from '@shared/project-icon'

/**
 * Project-icon upload, main side. The renderer must never trust a user-chosen file straight onto
 * `Project.icon` (it ships to every clone and re-renders on every load), so main is the boundary
 * that RE-ENCODES it: whatever the user picked — a 12MP photo, an animated GIF, an SVG — is decoded
 * by sharp and re-emitted as a small, square-bounded PNG. That normalises the format (no SVG script
 * surface, one MIME), caps the pixel size, and — with the byte-cap below — the file size, exactly
 * the guarantees `sanitizeProjectIcon` re-checks when the value is later read back from project.json.
 *
 * `sharp` is a native module: it is a runtime `dependencies` entry (electron.vite externalises deps,
 * so main `require`s it from node_modules) and is listed in electron-builder `asarUnpack`, so its
 * platform binary sits unpacked beside the app. Both are required for this to work in a packaged
 * build — without them the require would fail and the upload would be dead.
 */

/** The longest edge (px) a re-encoded icon is bounded to. Square box, `fit: 'inside'` preserves
 *  aspect ratio, and no enlargement so a tiny source is never blown up. */
const ICON_MAX_DIMENSION = 128

/**
 * Decode `input` as an image and re-encode it to a bounded PNG `data:` URL. Never throws: an
 * un-decodable buffer, or one that is still over `maxBytes` after re-encoding, comes back as an
 * `{ error }` the caller can surface. `maxBytes` is injectable purely so the cap path is testable
 * (a 128px PNG is in practice always well under 256 KB).
 */
export async function encodeProjectIconImage(
  input: Buffer,
  maxBytes: number = PROJECT_ICON_MAX_BYTES
): Promise<{ dataUrl: string } | { error: string }> {
  let png: Buffer
  try {
    png = await sharp(input)
      .resize(ICON_MAX_DIMENSION, ICON_MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
  } catch {
    return { error: 'That file could not be read as an image.' }
  }
  const dataUrl = `data:image/png;base64,${png.toString('base64')}`
  if (dataUrlByteLength(dataUrl) > maxBytes) {
    return { error: 'That image is too large even after resizing. Try a smaller one.' }
  }
  return { dataUrl }
}

/**
 * Open a file dialog for an image, then re-encode the chosen file via `encodeProjectIconImage`.
 * Returns `null` when the user cancels. Electron is required lazily so this module can be unit-
 * tested (against real sharp) without an Electron runtime.
 */
export async function pickProjectIcon(parentWindow?: unknown): Promise<ProjectIconPickResult> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { dialog, BrowserWindow } = require('electron') as typeof import('electron')
  const win =
    parentWindow instanceof BrowserWindow && !parentWindow.isDestroyed() ? parentWindow : null
  const opts: Electron.OpenDialogOptions = {
    title: 'Choose a project icon',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }]
  }
  const result = win
    ? await dialog.showOpenDialog(win, opts)
    : await dialog.showOpenDialog(opts)
  if (result.canceled || result.filePaths.length === 0) return null
  let buf: Buffer
  try {
    buf = await fsp.readFile(result.filePaths[0])
  } catch {
    return { error: 'That file could not be opened.' }
  }
  return encodeProjectIconImage(buf)
}
