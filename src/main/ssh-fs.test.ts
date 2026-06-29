import { describe, expect, it, vi } from 'vitest'
import { sshListArgs, sshReadArgs, sshReadBinaryArgs, sshWriteArgs, sshCheckIgnoreArgs, parseLsEntries, SshFs } from './ssh-fs'

const conn = { host: 'h', user: 'u' }
const ref = { conn, controlPath: '/s.sock' }

describe('ssh-fs arg builders', () => {
  it('list runs ls -Ap1 on the quoted path', () => {
    expect(sshListArgs(conn, '/s.sock', '/a b/c').join(' ')).toContain(`ls -Ap1 '/a b/c'`)
  })
  it('read cats the quoted path', () => {
    expect(sshReadArgs(conn, '/s.sock', "/x'y").join(' ')).toContain(`cat '/x'\\''y'`)
  })
  it('readBinary base64s the quoted path', () => {
    expect(sshReadBinaryArgs(conn, '/s.sock', '/i.png').join(' ')).toContain(`base64 '/i.png'`)
  })
  it('write mkdir -p the dirname then cat > the quoted path (content via stdin, not interpolated)', () => {
    const j = sshWriteArgs(conn, '/s.sock', '/d/e/f.txt').join(' ')
    expect(j).toContain(`mkdir -p '/d/e'`)
    expect(j).toContain(`cat > '/d/e/f.txt'`)
  })
  // CRITICAL: SSH projects default to a home-relative remoteCwd (`~`). quoteRemotePath must leave a
  // leading `~/` UNQUOTED so the remote shell tilde-expands it; the remainder stays single-quoted.
  it('list leaves a leading ~/ unquoted so the remote shell tilde-expands the path', () => {
    expect(sshListArgs(conn, '/s', '~/projects').join(' ')).toContain(`ls -Ap1 ~/'projects'`)
  })
  it('write keeps ~/ unquoted for BOTH the mkdir dirname and the cat target', () => {
    const j = sshWriteArgs(conn, '/s', '~/projects/file.txt').join(' ')
    expect(j).toContain(`mkdir -p ~/'projects'`)
    expect(j).toContain(`cat > ~/'projects/file.txt'`)
  })
  it('check-ignore quotes the dir as a remote path (~ expands) but quotes entry NAMES literally', () => {
    const j = sshCheckIgnoreArgs(conn, '/s', '~/p', ['node_modules', "a'b"]).join(' ')
    expect(j).toContain(`git -C ~/'p' check-ignore -- 'node_modules' 'a'\\''b'`)
  })
})

describe('parseLsEntries', () => {
  it('folders-first alphabetical, .git hidden, trailing-slash → dir', () => {
    expect(parseLsEntries('zeta.txt\nsrc/\n.git/\nalpha/\nb.md\n')).toEqual([
      { name: 'alpha', dir: true, ignored: false },
      { name: 'src', dir: true, ignored: false },
      { name: 'b.md', dir: false, ignored: false },
      { name: 'zeta.txt', dir: false, ignored: false }
    ])
  })
})

describe('SshFs (injected runner)', () => {
  it('readText returns stdout, empty on failure', async () => {
    expect(await new SshFs(async () => ({ code: 0, stdout: 'hi' })).readText(ref, '/x')).toBe('hi')
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).readText(ref, '/x')).toBe('')
  })
  it('writeText feeds content on stdin and returns true on code 0 / false otherwise', async () => {
    const run = vi.fn(async (_args: string[], _stdin?: string) => ({ code: 0, stdout: '' }))
    expect(await new SshFs(run).writeText(ref, '/d/f.txt', 'BODY')).toBe(true)
    expect(run.mock.calls[0][1]).toBe('BODY') // stdin
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).writeText(ref, '/x', 'b')).toBe(false)
  })
  it('listDir parses ls output and flags ignored from check-ignore', async () => {
    const run = vi.fn(async (args: string[]) =>
      args.join(' ').includes('check-ignore') ? { code: 0, stdout: 'node_modules\n' } : { code: 0, stdout: 'node_modules/\nsrc/\n' }
    )
    const out = await new SshFs(run).listDir(ref, '/p')
    expect(out).toEqual([
      { name: 'node_modules', dir: true, ignored: true },
      { name: 'src', dir: true, ignored: false }
    ])
  })
  it('fail-open: listDir → [] when the ls run fails', async () => {
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).listDir(ref, '/p')).toEqual([])
  })
})
