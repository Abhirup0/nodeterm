import { describe, it, expect } from 'vitest'
import { gitEnvFrom, GIT_POSIX_BIN_DIRS } from './git-env'

describe('gitEnvFrom', () => {
  it('darwin/linux: prepends the GUI-blind bin dirs, keeping the inherited PATH', () => {
    const env = gitEnvFrom({ PATH: '/usr/local/sbin:/usr/bin' }, 'darwin')
    expect(env.PATH).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/bin')
    expect(env.PATH!.split(':')).toContain('/usr/local/sbin')
  })

  it('posix with no inherited PATH: no trailing separator', () => {
    expect(gitEnvFrom({}, 'linux').PATH).toBe(GIT_POSIX_BIN_DIRS.join(':'))
  })

  // Issue #583. The old construction joined the POSIX dirs with a hardcoded ':' on every platform,
  // so Windows — which splits PATH on ';' — read the whole prefix plus the user's FIRST real entry
  // as one directory, and that entry became unreachable for every git child process.
  it('win32: leaves PATH exactly as inherited, so no entry fuses with a Unix prefix', () => {
    const inherited = 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd'
    const env = gitEnvFrom({ PATH: inherited }, 'win32')
    expect(env.PATH).toBe(inherited)
    expect(env.PATH!.split(';')[0]).toBe('C:\\Windows\\System32')
    expect(env.PATH).not.toContain('/opt/homebrew/bin')
  })

  it('win32: adds no PATH key of its own when the process spells it "Path"', () => {
    // Windows env vars are case-insensitive; a `PATH` we add beside an inherited `Path` is a
    // second entry for the same variable.
    const env = gitEnvFrom({ Path: 'C:\\Windows\\System32' } as NodeJS.ProcessEnv, 'win32')
    expect(Object.keys(env)).not.toContain('PATH')
    expect(env.Path).toBe('C:\\Windows\\System32')
  })

  it('carries GIT_TERMINAL_PROMPT=0 on every platform — it is what stops a TTY-less hang', () => {
    for (const p of ['darwin', 'linux', 'win32']) {
      expect(gitEnvFrom({ PATH: 'x' }, p).GIT_TERMINAL_PROMPT).toBe('0')
    }
  })

  it('passes the rest of the environment through untouched', () => {
    for (const p of ['darwin', 'win32']) {
      expect(gitEnvFrom({ HOME: '/home/x', GIT_ASKPASS: 'y' }, p)).toMatchObject({
        HOME: '/home/x',
        GIT_ASKPASS: 'y'
      })
    }
  })
})
