import { describe, it, expect } from 'vitest'
import { opensInEditor } from './openTarget'

describe('opensInEditor', () => {
  it('text and image files open in an editor node', () => {
    for (const p of ['src/a.ts', 'README.md', 'a/b.json', 'icon.png', 'photo.JPG', 'notes']) {
      expect(opensInEditor(p)).toBe(true)
    }
  })
  it('binary/app artifacts open with the OS instead', () => {
    for (const p of ['dist/app.dmg', 'x.zip', 'y.pkg', 'App.app/Contents/Info', 'a.tar.gz']) {
      expect(opensInEditor(p)).toBe(false)
    }
  })
})
