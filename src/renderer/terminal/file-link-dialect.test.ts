import { describe, expect, it } from 'vitest'
import { fileLinkDialect, type FileLinkDialectFacts } from './file-link-dialect'

const facts = (overrides: Partial<FileLinkDialectFacts> = {}): FileLinkDialectFacts => ({
  source: 'local',
  browserRuntime: false,
  viewerWindows: false,
  corePlatform: null,
  sshProject: false,
  standaloneSsh: false,
  ...overrides
})

describe('fileLinkDialect', () => {
  it('uses the local desktop viewer only where viewer and filesystem host are the same machine', () => {
    expect(fileLinkDialect(facts({ viewerWindows: true }))).toBe('windows')
    expect(fileLinkDialect(facts({ viewerWindows: false }))).toBe('posix')
  })

  it('uses the Server Edition host rather than the browser OS', () => {
    expect(
      fileLinkDialect(
        facts({ source: 'local', browserRuntime: true, viewerWindows: true, corePlatform: 'linux' })
      )
    ).toBe('posix')
    expect(
      fileLinkDialect(
        facts({ source: 'local', browserRuntime: true, viewerWindows: false, corePlatform: 'win32' })
      )
    ).toBe('windows')
  })

  it('uses the relay host rather than the relay guest OS', () => {
    expect(
      fileLinkDialect(facts({ source: 'relay', viewerWindows: true, corePlatform: 'darwin' }))
    ).toBe('posix')
    expect(
      fileLinkDialect(facts({ source: 'relay', viewerWindows: false, corePlatform: 'win32' }))
    ).toBe('windows')
  })

  it('treats an SSH project as POSIX even when its desktop core is Windows', () => {
    expect(
      fileLinkDialect(facts({ viewerWindows: true, corePlatform: 'win32', sshProject: true }))
    ).toBe('posix')
  })

  it('refuses a standalone ssh terminal because no remote fs API can verify its paths', () => {
    expect(fileLinkDialect(facts({ standaloneSsh: true, corePlatform: 'win32' }))).toBeNull()
  })

  it('does not guess from a browser when the server or relay host platform read failed', () => {
    expect(
      fileLinkDialect(facts({ source: 'local', browserRuntime: true, viewerWindows: true }))
    ).toBeNull()
    expect(fileLinkDialect(facts({ source: 'server', viewerWindows: true }))).toBeNull()
    expect(fileLinkDialect(facts({ source: 'relay', viewerWindows: false }))).toBeNull()
  })
})
