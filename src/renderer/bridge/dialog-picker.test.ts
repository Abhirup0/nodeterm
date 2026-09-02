import { describe, it, expect, vi } from 'vitest'
import { createPickerFolder, nextEntries, type PickerMkdirDeps } from './dialog-picker'
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

// ── "New folder" (folder mode only; Server Edition + relay tabs) ─────────────────────────────
// `createPickerFolder` is the whole create step. It reuses the Explorer's `newEntryPath`
// envelope rather than validating paths a second time, so the cases below are the picker's
// contract with that envelope, not a re-test of it.
describe('createPickerFolder', () => {
  const deps = (over: Partial<PickerMkdirDeps> = {}): PickerMkdirDeps => ({
    exists: vi.fn(async () => false),
    mkdir: vi.fn(async () => true),
    ...over
  })

  it('creates the folder under the current dir and reports its absolute path', async () => {
    const d = deps()
    await expect(createPickerFolder('/home/u', 'proj', d)).resolves.toEqual({
      ok: true,
      path: '/home/u/proj'
    })
    expect(d.mkdir).toHaveBeenCalledWith('/home/u/proj')
  })

  it('joins correctly at the filesystem root', async () => {
    const d = deps()
    await expect(createPickerFolder('/', 'srv', d)).resolves.toEqual({ ok: true, path: '/srv' })
  })

  it('normalizes a trailing slash on the current dir', async () => {
    const d = deps()
    await expect(createPickerFolder('/home/u/', 'proj', d)).resolves.toEqual({
      ok: true,
      path: '/home/u/proj'
    })
  })

  // The jail: whatever the picker can navigate to, it can create in — and nothing else. `..`,
  // an absolute name and an empty one are refused by `newEntryPath` BEFORE any fs call.
  it.each([
    ['..', '/home/u'],
    ['../evil', '/home/u'],
    ['a/../../evil', '/home/u'],
    ['/etc/passwd', '/home/u'],
    ['', '/home/u'],
    ['   ', '/home/u']
  ])('refuses %s without touching the filesystem', async (name, dir) => {
    const d = deps()
    const res = await createPickerFolder(dir, name, d)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.error).toMatch(/^Invalid name:/)
    expect(d.mkdir).not.toHaveBeenCalled()
    expect(d.exists).not.toHaveBeenCalled()
  })

  it('never overwrites: an existing path is refused by name, with no mkdir', async () => {
    const d = deps({ exists: vi.fn(async () => true) })
    const res = await createPickerFolder('/home/u', 'proj', d)
    expect(res).toEqual({ ok: false, error: 'Already exists: /home/u/proj' })
    expect(d.mkdir).not.toHaveBeenCalled()
  })

  // A refused mkdir (no write permission on the parent) must READ as a refusal — the silent
  // no-op is what makes a server picker feel broken.
  it('surfaces a failed mkdir as a readable error naming the path', async () => {
    const d = deps({ mkdir: vi.fn(async () => false) })
    await expect(createPickerFolder('/srv', 'x', d)).resolves.toEqual({
      ok: false,
      error: 'Could not create /srv/x'
    })
  })

  // mkdir is `mkdir -p`, so a nested name is a legitimate way to make a whole path at once;
  // the deepest dir is what the picker then navigates into.
  it('allows a nested name and reports the deepest path', async () => {
    const d = deps()
    await expect(createPickerFolder('/home/u', 'a/b', d)).resolves.toEqual({
      ok: true,
      path: '/home/u/a/b'
    })
    expect(d.mkdir).toHaveBeenCalledWith('/home/u/a/b')
  })
})
