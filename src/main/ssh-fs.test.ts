import { describe, expect, it, vi } from 'vitest'
import { sshListArgs, sshReadArgs, sshReadBinaryArgs, sshWriteArgs, sshMkdirArgs, sshExistsArgs, sshCheckIgnoreArgs, parseLsEntries, SshFs } from './ssh-fs'

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
  // ATOMIC: `cat > file` truncates the target the moment it opens, so a connection dropped (or the
  // ControlMaster killed at quit) mid-write left a HALF/EMPTY file behind — for .nodeterm/project.json
  // that read as "my project reset itself". Write a sibling .tmp, then mv into place.
  it('write mkdir -p the dirname, cat > a sibling .tmp, then mv into place (content via stdin)', () => {
    const j = sshWriteArgs(conn, '/s.sock', '/d/e/f.txt').join(' ')
    expect(j).toContain(`mkdir -p '/d/e'`)
    expect(j).toContain(`cat > '/d/e/f.txt.tmp'`)
    expect(j).toContain(`mv -f '/d/e/f.txt.tmp' '/d/e/f.txt'`)
  })
  // CRITICAL: SSH projects default to a home-relative remoteCwd (`~`). quoteRemotePath must leave a
  // leading `~/` UNQUOTED so the remote shell tilde-expands it; the remainder stays single-quoted.
  it('list leaves a leading ~/ unquoted so the remote shell tilde-expands the path', () => {
    expect(sshListArgs(conn, '/s', '~/projects').join(' ')).toContain(`ls -Ap1 ~/'projects'`)
  })
  it('write keeps ~/ unquoted for the mkdir dirname, the .tmp target and the mv', () => {
    const j = sshWriteArgs(conn, '/s', '~/projects/file.txt').join(' ')
    expect(j).toContain(`mkdir -p ~/'projects'`)
    expect(j).toContain(`cat > ~/'projects/file.txt.tmp'`)
    expect(j).toContain(`mv -f ~/'projects/file.txt.tmp' ~/'projects/file.txt'`)
  })
  it('mkdir runs mkdir -p on the quoted path', () => {
    expect(sshMkdirArgs(conn, '/s.sock', '/a b/c').join(' ')).toContain(`mkdir -p '/a b/c'`)
  })
  it('mkdir leaves a leading ~/ unquoted so the remote shell tilde-expands the path', () => {
    expect(sshMkdirArgs(conn, '/s', '~/projects/new').join(' ')).toContain(`mkdir -p ~/'projects/new'`)
  })
  it('exists runs test -e on the quoted path', () => {
    expect(sshExistsArgs(conn, '/s.sock', '/a b/c').join(' ')).toContain(`test -e '/a b/c'`)
  })
  it('exists leaves a leading ~/ unquoted so the remote shell tilde-expands the path', () => {
    expect(sshExistsArgs(conn, '/s', '~/projects/file.txt').join(' ')).toContain(`test -e ~/'projects/file.txt'`)
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
  it('mkdir true on code 0, false otherwise', async () => {
    expect(await new SshFs(async () => ({ code: 0, stdout: '' })).mkdir(ref, '/d')).toBe(true)
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).mkdir(ref, '/d')).toBe(false)
  })
  it('exists true on code 0 (test -e), false otherwise', async () => {
    expect(await new SshFs(async () => ({ code: 0, stdout: '' })).exists(ref, '/d')).toBe(true)
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).exists(ref, '/d')).toBe(false)
  })

  // readText can't tell "the file is not there" from "the connection is down" — both come back ''.
  // For workspace reconciliation that difference is load-bearing: absent → push our cache up,
  // error → do NOTHING (a failed read is never evidence of absence). ssh itself exits 255 on any
  // connection/auth failure; a remote `cat` on a missing file exits 1.
  it('readTextChecked: exit 0 → ok+content, remote non-zero → absent, ssh 255/throw → error', async () => {
    expect(await new SshFs(async () => ({ code: 0, stdout: 'hi' })).readTextChecked(ref, '/x')).toEqual({ status: 'ok', content: 'hi' })
    expect(await new SshFs(async () => ({ code: 1, stdout: '' })).readTextChecked(ref, '/x')).toEqual({ status: 'absent' })
    expect(await new SshFs(async () => ({ code: 255, stdout: '' })).readTextChecked(ref, '/x')).toEqual({ status: 'error' })
    expect(await new SshFs(async () => { throw new Error('spawn') }).readTextChecked(ref, '/x')).toEqual({ status: 'error' })
  })
})
