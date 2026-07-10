import { describe, it, expect, vi } from 'vitest'
import { nextEntries } from './dialog-picker'
import type { DirEntry } from '../../shared/types'

// The real `DirEntry` (src/shared/types.ts) is `{ name, dir, ignored? }` — it uses `dir`
// (not `isDirectory`) and carries NO absolute path. So `nextEntries` filters on `.dir` and
// synthesizes each row's absolute path from the current dir (`currentDir + '/' + name`).

describe('dialog-picker navigation helper', () => {
  const list = vi.fn(
    async (p: string): Promise<DirEntry[]> =>
      p === '/home/u'
        ? [
            { name: 'proj', dir: true },
            { name: 'note.txt', dir: false }
          ]
        : []
  )

  it('lists dirs and (file mode) files, with a parent when not at root', async () => {
    const folderView = await nextEntries('/home/u', 'folder', list)
    expect(folderView.parent).toBe('/home')
    expect(folderView.rows.map((r) => r.name)).toEqual(['proj']) // folder mode hides files

    const fileView = await nextEntries('/home/u', 'file', list)
    expect(fileView.rows.map((r) => r.name)).toEqual(['proj', 'note.txt'])
  })

  it('resolves each row to an absolute path under the current dir', async () => {
    const view = await nextEntries('/home/u', 'file', list)
    expect(view.rows.map((r) => r.path)).toEqual(['/home/u/proj', '/home/u/note.txt'])
  })

  it('joins correctly at the filesystem root (no double slash)', async () => {
    const rootList = vi.fn(async (): Promise<DirEntry[]> => [{ name: 'etc', dir: true }])
    const view = await nextEntries('/', 'folder', rootList)
    expect(view.rows.map((r) => r.path)).toEqual(['/etc'])
  })

  it('parent is null at filesystem root', async () => {
    const view = await nextEntries('/', 'folder', vi.fn(async () => []))
    expect(view.parent).toBeNull()
  })

  it('normalizes a trailing slash when computing the parent', async () => {
    const view = await nextEntries('/home/u/', 'folder', vi.fn(async () => []))
    expect(view.parent).toBe('/home')
  })
})
