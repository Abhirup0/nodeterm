import { describe, expect, it } from 'vitest'
import { isMarkdownExt, opensInPreview } from './markdownPreview'

describe('isMarkdownExt', () => {
  it('accepts the markdown family', () => {
    for (const ext of ['md', 'markdown', 'mdown', 'mkd']) {
      expect(isMarkdownExt(ext)).toBe(true)
    }
  })

  it('is case-insensitive (a file named README.MD is still markdown)', () => {
    expect(isMarkdownExt('MD')).toBe(true)
  })

  it('rejects everything else, including the empty extension', () => {
    for (const ext of ['ts', 'txt', 'html', 'mdx', 'json', '']) {
      expect(isMarkdownExt(ext)).toBe(false)
    }
  })
})

describe('opensInPreview', () => {
  it('requires the setting AND a markdown extension', () => {
    expect(opensInPreview('md', true)).toBe(true)
    expect(opensInPreview('md', false)).toBe(false)
    expect(opensInPreview('ts', true)).toBe(false)
  })

  it('setting off is the historical behavior for every file', () => {
    expect(opensInPreview('markdown', false)).toBe(false)
  })
})
