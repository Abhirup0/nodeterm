/**
 * Turn base64 file bytes into a `blob:` URL the platform's own PDF viewer can load.
 *
 * A `data:` URL (what the image preview uses) is not an option here: a PDF is framed as a
 * document, and a `data:` URL in a frame is treated as an opaque/untrusted origin, so the viewer
 * renders nothing. A blob URL is same-origin — which is also why the renderer CSP carries
 * `frame-src 'self' blob:`.
 *
 * Lives apart from EditorNode so it can be tested: importing that component drags in the Monaco
 * `?worker` modules, which do not resolve outside the Vite build.
 *
 * Returns null when the base64 cannot be decoded, so the caller reports a read failure instead of
 * framing an empty document.
 */
export function pdfBlobUrl(b64: string): string | null {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    // charCodeAt per byte, NOT TextEncoder: a PDF is binary, and re-encoding it as UTF-8 would
    // rewrite every byte above 0x7f into a multi-byte sequence and corrupt the document.
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  } catch {
    return null
  }
}
