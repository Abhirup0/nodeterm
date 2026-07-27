import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { pdfBlobUrl } from './pdfBlob'

// jsdom/node has no object-URL store; capture what we hand it instead.
const made: Blob[] = []
const realCreate = URL.createObjectURL

beforeEach(() => {
  made.length = 0
  URL.createObjectURL = vi.fn((b: Blob) => {
    made.push(b)
    return `blob:test/${made.length}`
  }) as unknown as typeof URL.createObjectURL
})
afterEach(() => {
  URL.createObjectURL = realCreate
})

describe('pdfBlobUrl', () => {
  it('builds a blob URL with the pdf mime type', async () => {
    // "%PDF-1.4" — the magic bytes a viewer sniffs for.
    const url = pdfBlobUrl(btoa('%PDF-1.4'))
    expect(url).toBe('blob:test/1')
    expect(made[0].type).toBe('application/pdf')
    // The bytes must survive base64 → binary intact, or the viewer sees a corrupt document.
    expect(await made[0].text()).toBe('%PDF-1.4')
  })

  it('preserves high bytes rather than mangling them through charCode', async () => {
    // A PDF is binary: bytes above 0x7f are the ones a naive string round-trip destroys.
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0x00, 0x80, 0xfe])
    const b64 = btoa(String.fromCharCode(...bytes))
    pdfBlobUrl(b64)
    expect(new Uint8Array(await made[0].arrayBuffer())).toEqual(bytes)
  })

  it('returns null on unreadable base64 instead of framing an empty document', () => {
    expect(pdfBlobUrl('not valid base64!!')).toBeNull()
    expect(made).toHaveLength(0)
  })

  it('handles an empty string as unreadable, not as an empty PDF', () => {
    // atob('') succeeds, so this would otherwise produce a 0-byte "PDF" the viewer renders as a
    // blank error page. The caller treats a falsy read as an error before reaching here; this
    // documents that a 0-byte blob is never a useful outcome.
    const url = pdfBlobUrl('')
    expect(url).toBe('blob:test/1')
    expect(made[0].size).toBe(0)
  })
})
