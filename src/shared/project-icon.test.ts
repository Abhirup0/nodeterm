import { describe, it, expect } from 'vitest'
import {
  sanitizeProjectIcon, dataUrlByteLength, LUCIDE_ICON_IDS, PROJECT_ICON_MAX_BYTES
} from './project-icon'

const png1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

describe('sanitizeProjectIcon: kept', () => {
  it('keeps a valid emoji icon', () => {
    expect(sanitizeProjectIcon({ type: 'emoji', emoji: '🚀' })).toEqual({ type: 'emoji', emoji: '🚀' })
  })
  it('keeps a 16-code-unit emoji (boundary)', () => {
    const emoji = 'x'.repeat(16)
    expect(sanitizeProjectIcon({ type: 'emoji', emoji })).toEqual({ type: 'emoji', emoji })
  })
  it('keeps a known lucide id', () => {
    expect(sanitizeProjectIcon({ type: 'lucide', name: 'rocket' })).toEqual({ type: 'lucide', name: 'rocket' })
  })
  it('keeps a valid data: image icon under the byte cap', () => {
    expect(sanitizeProjectIcon({ type: 'image', src: png1x1, source: 'upload' }))
      .toEqual({ type: 'image', src: png1x1, source: 'upload' })
  })
  it('accepts every allowed image MIME + source combo', () => {
    for (const mime of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
      for (const source of ['github', 'upload', 'favicon'] as const) {
        const src = `data:${mime};base64,QQ==`
        expect(sanitizeProjectIcon({ type: 'image', src, source })).toEqual({ type: 'image', src, source })
      }
    }
  })
})

describe('sanitizeProjectIcon: rejected (never throws, degrades to undefined)', () => {
  it('rejects non-object input', () => {
    expect(sanitizeProjectIcon(null)).toBeUndefined()
    expect(sanitizeProjectIcon(undefined)).toBeUndefined()
    expect(sanitizeProjectIcon('rocket')).toBeUndefined()
    expect(sanitizeProjectIcon(42)).toBeUndefined()
    expect(sanitizeProjectIcon([])).toBeUndefined()
  })
  it('rejects an unknown type', () => {
    expect(sanitizeProjectIcon({ type: 'svg', markup: '<svg/>' })).toBeUndefined()
    expect(sanitizeProjectIcon({})).toBeUndefined()
  })
  it('rejects a 17-code-unit emoji', () => {
    expect(sanitizeProjectIcon({ type: 'emoji', emoji: 'x'.repeat(17) })).toBeUndefined()
  })
  it('rejects an empty emoji', () => {
    expect(sanitizeProjectIcon({ type: 'emoji', emoji: '' })).toBeUndefined()
  })
  it('rejects a non-string emoji', () => {
    expect(sanitizeProjectIcon({ type: 'emoji', emoji: 7 })).toBeUndefined()
  })
  it('rejects an unknown lucide id', () => {
    expect(sanitizeProjectIcon({ type: 'lucide', name: 'not-a-real-icon' })).toBeUndefined()
  })
  it('rejects a non-string lucide name', () => {
    expect(sanitizeProjectIcon({ type: 'lucide', name: 123 })).toBeUndefined()
  })
  it('rejects an http(s) src (not a data: URL)', () => {
    expect(sanitizeProjectIcon({
      type: 'image', src: 'https://evil.test/track.png', source: 'upload'
    })).toBeUndefined()
  })
  it('rejects an oversized data: URL', () => {
    const bigB64 = 'A'.repeat(Math.ceil((PROJECT_ICON_MAX_BYTES + 1024) / 3) * 4)
    const src = `data:image/png;base64,${bigB64}`
    expect(dataUrlByteLength(src)).toBeGreaterThan(PROJECT_ICON_MAX_BYTES)
    expect(sanitizeProjectIcon({ type: 'image', src, source: 'upload' })).toBeUndefined()
  })
  it('rejects a wrong/disallowed MIME type', () => {
    expect(sanitizeProjectIcon({
      type: 'image', src: 'data:image/svg+xml;base64,QQ==', source: 'upload'
    })).toBeUndefined()
    expect(sanitizeProjectIcon({
      type: 'image', src: 'data:text/html;base64,QQ==', source: 'upload'
    })).toBeUndefined()
  })
  it('rejects a missing/unknown source', () => {
    expect(sanitizeProjectIcon({ type: 'image', src: png1x1 })).toBeUndefined()
    expect(sanitizeProjectIcon({ type: 'image', src: png1x1, source: 'random' })).toBeUndefined()
  })
})

describe('LUCIDE_ICON_IDS', () => {
  it('is a non-empty curated list with no duplicates', () => {
    expect(LUCIDE_ICON_IDS.length).toBeGreaterThan(0)
    expect(new Set(LUCIDE_ICON_IDS).size).toBe(LUCIDE_ICON_IDS.length)
  })
})

describe('dataUrlByteLength', () => {
  it('is 0 for a non-data URL', () => {
    expect(dataUrlByteLength('https://x.test/a.png')).toBe(0)
    expect(dataUrlByteLength('not a url')).toBe(0)
  })
  it('never throws on garbage input', () => {
    expect(dataUrlByteLength('data:image/png;base64,%%%not-base64%%%')).toBeGreaterThanOrEqual(0)
    expect(dataUrlByteLength('data:text/plain,%zz')).toBe(0)
  })
  it('decodes a known base64 payload exactly', () => {
    // btoa('hello') === 'aGVsbG8=' — 5 bytes.
    expect(dataUrlByteLength('data:text/plain;base64,aGVsbG8=')).toBe(5)
  })
})
