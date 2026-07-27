import { describe, it, expect } from 'vitest'
import { candidateName, safeDownloadBasename } from './download-name'

describe('safeDownloadBasename', () => {
  it('takes the basename of a remote path', () => {
    expect(safeDownloadBasename('/srv/app/docs/notes.md')).toBe('notes.md')
    expect(safeDownloadBasename('~/work/report.pdf')).toBe('report.pdf')
    expect(safeDownloadBasename('/srv/app/docs/')).toBe('docs')
  })

  it('refuses paths that name nothing writable', () => {
    for (const p of ['', '/', '.', '..', '~', '/srv/..']) expect(safeDownloadBasename(p)).toBeNull()
  })

  it('neutralizes separators and control characters rather than refusing the download', () => {
    expect(safeDownloadBasename('/srv/a\\b.txt')).toBe('a_b.txt')
    expect(safeDownloadBasename('/srv/we:ird?.txt')).toBe('we_ird_.txt')
    expect(safeDownloadBasename('/srv/nl\nname')).toBe('nl_name')
  })

  it('cannot produce a traversal component', () => {
    // A remote file literally named `..` (or `../x` as one component) must never come back as one.
    expect(safeDownloadBasename('/srv/app/..')).toBeNull()
    expect(safeDownloadBasename('/srv/app/...')).toBe('...')
  })
})

describe('candidateName', () => {
  it('leaves the first attempt alone', () => {
    expect(candidateName('notes.md', 1)).toBe('notes.md')
    expect(candidateName('notes.md', 0)).toBe('notes.md')
  })

  it('numbers before the extension', () => {
    expect(candidateName('notes.md', 2)).toBe('notes (2).md')
    expect(candidateName('archive.tar.gz', 3)).toBe('archive.tar (3).gz')
  })

  it('appends at the end when there is no extension to protect', () => {
    expect(candidateName('README', 2)).toBe('README (2)')
    expect(candidateName('.bashrc', 2)).toBe('.bashrc (2)')
  })
})
