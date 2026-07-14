import { describe, expect, it, vi } from 'vitest'
import { RemoteHooks } from './remote-hooks'

const conn = { host: 'h', user: 'u' }

function mk() {
  const calls: { args: string[]; stdin?: string }[] = []
  const run = vi.fn(async (args: string[], stdin?: string) => {
    calls.push({ args, stdin })
    const joined = args.join(' ')
    // resolve the remote $HOME probe → absolute remote paths build from this.
    if (joined.includes('$HOME')) return { code: 0, stdout: '/home/u' }
    if (joined.includes('cat /home/u/.claude/settings.json')) return { code: 0, stdout: '{}' }
    return { code: 0, stdout: '' }
  })
  return { rh: new RemoteHooks({ run }), calls, run }
}

describe('RemoteHooks.setup', () => {
  it('opens a reverse forward, writes the endpoint file, and installs the managed hook for claude', async () => {
    const { rh, calls } = mk()
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    // Endpoint file is PER-PROJECT (was a single shared hook-endpoint.env): each connection —
    // real project OR a transient folder-picker browse — has its own reverse-tunnel socket, so a
    // shared file let the last writer (often a short-lived browse whose tunnel then died) point
    // every session at a dead socket, silently killing hook delivery for all real projects.
    expect(res?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
    const joined = calls.map((c) => c.args.join(' '))
    // reverse forward binds the ABSOLUTE remote socket (no unexpanded ~).
    expect(joined.some((j) => j.includes('-O forward') && j.includes('/home/u/.nodeterm/hook-p1.sock:127.0.0.1:51234'))).toBe(true)
    // endpoint file written to the absolute PER-PROJECT path, with the absolute sock + token.
    expect(joined.some((j) => j.includes('cat > /home/u/.nodeterm/hook-endpoint-p1.env'))).toBe(true)
    expect(
      calls.some(
        (c) =>
          (c.stdin ?? '').includes('NODETERM_HOOK_TOKEN=tok') &&
          (c.stdin ?? '').includes('NODETERM_HOOK_SOCK=/home/u/.nodeterm/hook-p1.sock')
      )
    ).toBe(true)
    // managed script written to the absolute path + config merged with `sh "<abs script>"`.
    expect(joined.some((j) => j.includes('cat > /home/u/.nodeterm/agent-hooks/claude.sh'))).toBe(true)
    expect(joined.some((j) => j.includes('cat > /home/u/.claude/settings.json'))).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('--unix-socket'))).toBe(true)
    // merged config is JSON, so the command quotes are escaped: sh \"<abs script>\".
    expect(calls.some((c) => (c.stdin ?? '').includes('sh \\"/home/u/.nodeterm/agent-hooks/claude.sh\\"'))).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('"hooks"'))).toBe(true)
    // no unexpanded tilde survives in any remote path/command.
    expect(joined.some((j) => j.includes('~/'))).toBe(false)
  })

  it('gives two different projects (or a browse) distinct endpoint files — no shared clobber', async () => {
    const a = await mk().rh.setup('proj', conn, '/s', { port: 1, token: 't', version: '1' })
    const { rh, calls } = mk()
    const b = await rh.setup('ssh-browse-xyz', conn, '/s', { port: 2, token: 't', version: '1' })
    expect(a?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-proj.env')
    expect(b?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-ssh-browse-xyz.env')
    // the browse writes ITS OWN endpoint file, never the real project's.
    const joined = calls.map((c) => c.args.join(' '))
    expect(joined.some((j) => j.includes('cat > /home/u/.nodeterm/hook-endpoint-ssh-browse-xyz.env'))).toBe(true)
    expect(joined.some((j) => j.includes('hook-endpoint-proj.env'))).toBe(false)
  })
})

describe('RemoteHooks.ensureFullscreenTui', () => {
  // Paths are posixQuote'd (single-quoted) in the remote commands; a read is `cat '<path>' …`
  // and a write is `… cat > '<path>'`, so we distinguish them by the presence of `cat >`.
  const isWriteTo = (args: string[], p: string) => args.join(' ').includes(`cat > `) && args.join(' ').includes(p)
  const isReadOf = (args: string[], p: string) =>
    !args.join(' ').includes('cat > ') && args.join(' ').includes(`cat `) && args.join(' ').includes(p)

  it('writes tui=fullscreen into the host settings when absent (preserving other keys)', async () => {
    const target = '/home/u/.claude/settings.json'
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      if (isReadOf(args, target)) return { code: 0, stdout: JSON.stringify({ hooks: { Stop: [] } }) }
      return { code: 0, stdout: '' }
    })
    const rh = new RemoteHooks({ run })
    await rh.ensureFullscreenTui(conn, '/s.sock', '/home/u')
    const write = calls.find((c) => isWriteTo(c.args, target))
    expect(write).toBeTruthy()
    expect(JSON.parse(write!.stdin!)).toEqual({ hooks: { Stop: [] }, tui: 'fullscreen' })
  })

  it('never overwrites an existing tui value (write-if-absent) — no write issued', async () => {
    const target = '/home/u/.claude/settings.json'
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[]) => {
      calls.push({ args })
      if (isReadOf(args, target)) return { code: 0, stdout: JSON.stringify({ tui: 'default' }) }
      return { code: 0, stdout: '' }
    })
    const rh = new RemoteHooks({ run })
    await rh.ensureFullscreenTui(conn, '/s.sock', '/home/u')
    expect(calls.some((c) => isWriteTo(c.args, target))).toBe(false)
  })

  it('writes into the absolute account-dir settings path', async () => {
    const target = '/home/u/.nodeterm/claude-accounts/acc-1/settings.json'
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      return { code: 0, stdout: '{}' } // any read → empty settings
    })
    const rh = new RemoteHooks({ run })
    await rh.ensureFullscreenTuiInAccountDir(conn, '/s.sock', '/home/u', 'acc-1')
    expect(calls.some((c) => isWriteTo(c.args, target))).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('"tui": "fullscreen"'))).toBe(true)
  })
})

describe('RemoteHooks.teardown', () => {
  it('cancels the reverse forward', async () => {
    const { rh, run } = mk()
    await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 't', version: '1' })
    run.mockClear()
    await rh.teardown('p1', conn, '/s.sock')
    // cancels using the SAME absolute sock path stored at setup.
    expect(
      run.mock.calls.some(
        ([a]) => a.join(' ').includes('-O cancel') && a.join(' ').includes('/home/u/.nodeterm/hook-p1.sock:127.0.0.1:51234')
      )
    ).toBe(true)
  })
})
