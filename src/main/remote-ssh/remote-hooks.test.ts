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
    expect(res?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint.env')
    const joined = calls.map((c) => c.args.join(' '))
    // reverse forward binds the ABSOLUTE remote socket (no unexpanded ~).
    expect(joined.some((j) => j.includes('-O forward') && j.includes('/home/u/.nodeterm/hook-p1.sock:127.0.0.1:51234'))).toBe(true)
    // endpoint file written to the absolute path, with the absolute sock + token.
    expect(joined.some((j) => j.includes('cat > /home/u/.nodeterm/hook-endpoint.env'))).toBe(true)
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
