import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { executableCandidates, findInPathString, unquotePathEntry } from './exec-path'

describe('executableCandidates', () => {
  it('leaves a bare name alone off win32 — POSIX has no PATHEXT', () => {
    expect(executableCandidates('gh', 'darwin', undefined)).toEqual(['gh'])
    expect(executableCandidates('gh', 'linux', '.EXE')).toEqual(['gh'])
  })

  it('appends PATHEXT on win32, bare name first', () => {
    // The regression this closes: `gh` on Windows is `gh.exe`, so a bare-name-only walk found
    // nothing and every caller fell through to its POSIX fallbacks.
    expect(executableCandidates('gh', 'win32', '.COM;.EXE;.CMD')).toEqual([
      'gh',
      'gh.COM',
      'gh.EXE',
      'gh.CMD'
    ])
  })

  it('falls back to the stock PATHEXT when the variable is missing or empty', () => {
    expect(executableCandidates('ssh', 'win32', undefined)).toEqual([
      'ssh',
      'ssh.COM',
      'ssh.EXE',
      'ssh.BAT',
      'ssh.CMD'
    ])
    expect(executableCandidates('ssh', 'win32', '')).toEqual(
      executableCandidates('ssh', 'win32', undefined)
    )
  })

  it('tolerates whitespace and empty entries in PATHEXT', () => {
    expect(executableCandidates('gh', 'win32', ' .EXE ; ; .CMD ')).toEqual([
      'gh',
      'gh.EXE',
      'gh.CMD'
    ])
  })

  it('does not double up on a name that already carries an extension', () => {
    expect(executableCandidates('gh.exe', 'win32', '.COM;.EXE')).toEqual(['gh.exe'])
    // Case-insensitively: Windows does not care, and neither should the guard.
    expect(executableCandidates('claude.CMD', 'win32', '.EXE;.cmd')).toEqual(['claude.CMD'])
  })
})

describe('unquotePathEntry', () => {
  it('strips the quotes Windows tolerates around a PATH entry', () => {
    expect(unquotePathEntry('"C:\Program Files\GitHub CLI"')).toBe('C:\Program Files\GitHub CLI')
  })

  it('leaves an unquoted entry and a lone quote untouched', () => {
    expect(unquotePathEntry('/usr/bin')).toBe('/usr/bin')
    expect(unquotePathEntry('"C:\half')).toBe('"C:\half')
  })
})

// End-to-end over the real filesystem: the unit tests above prove the NAME mapping, these prove the
// walk actually resolves those names — the half that was broken. Split by platform because the
// mapping they exercise only exists on one of them.
describe('findInPathString (real filesystem)', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-exec-path-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /** POSIX needs the exec bit for X_OK; on Windows the mode is ignored and F_OK is what we ask. */
  const writeBin = (name: string): string => {
    const p = path.join(dir, name)
    fs.writeFileSync(p, '', { mode: 0o755 })
    return p
  }

  /** A win32 hit carries PATHEXT's casing (`.EXE`), not the file's own — the same path, since
   *  Windows is case-insensitive. Compare the way the platform does. */
  const expectPath = (got: string | null, want: string): void => {
    expect(process.platform === 'win32' ? got?.toLowerCase() : got).toBe(
      process.platform === 'win32' ? want.toLowerCase() : want
    )
  }

  it('finds an executable that is on the PATH, and answers null for one that is not', () => {
    const bin = process.platform === 'win32' ? 'nt-probe.exe' : 'nt-probe'
    writeBin(bin)
    expectPath(findInPathString(process.platform === 'win32' ? 'nt-probe' : bin, dir), path.join(dir, bin))
    expect(findInPathString('nt-absent', dir)).toBeNull()
  })

  it('skips empty entries and searches later ones', () => {
    const bin = process.platform === 'win32' ? 'nt-probe.exe' : 'nt-probe'
    writeBin(bin)
    const pathStr = ['', path.join(dir, 'nope'), dir].join(path.delimiter)
    expectPath(findInPathString(process.platform === 'win32' ? 'nt-probe' : bin, pathStr), path.join(dir, bin))
  })

  it('tolerates a quoted PATH entry', () => {
    const bin = process.platform === 'win32' ? 'nt-probe.exe' : 'nt-probe'
    writeBin(bin)
    expectPath(
      findInPathString(process.platform === 'win32' ? 'nt-probe' : bin, `"${dir}"`),
      path.join(dir, bin)
    )
  })

  // The regression itself: a bare name must reach `<name>.exe` / `<name>.cmd` on disk. `gh` really
  // is `gh.exe` and an npm shim really is `<name>.cmd`, and resolving neither is what left Windows
  // with no gh, no ssh and a claude probe that never ran.
  describe.skipIf(process.platform !== 'win32')('win32 PATHEXT', () => {
    it('resolves a bare name to its .exe and .cmd on disk', () => {
      writeBin('nt-exe-only.exe')
      writeBin('nt-cmd-only.cmd')
      expectPath(findInPathString('nt-exe-only', dir), path.join(dir, 'nt-exe-only.exe'))
      expectPath(findInPathString('nt-cmd-only', dir), path.join(dir, 'nt-cmd-only.cmd'))
    })

    it('prefers an extensionless file when one exists, and still finds a name given in full', () => {
      writeBin('nt-both')
      writeBin('nt-both.exe')
      expectPath(findInPathString('nt-both', dir), path.join(dir, 'nt-both'))
      expectPath(findInPathString('nt-both.exe', dir), path.join(dir, 'nt-both.exe'))
    })
  })
})
