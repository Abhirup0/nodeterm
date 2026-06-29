import { describe, expect, it, vi } from 'vitest'
import { RemoteHooks } from './remote-hooks'

const conn = { host: 'h', user: 'u' }

function mk() {
  const calls: { args: string[]; stdin?: string }[] = []
  const run = vi.fn(async (args: string[], stdin?: string) => {
    calls.push({ args, stdin })
    if (args.join(' ').includes('cat ~/.claude/settings.json')) return { code: 0, stdout: '{}' }
    return { code: 0, stdout: '' }
  })
  return { rh: new RemoteHooks({ run }), calls, run }
}

describe('RemoteHooks.setup', () => {
  it('opens a reverse forward, writes the endpoint file, and installs the managed hook for claude', async () => {
    const { rh, calls } = mk()
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res?.endpointPath).toMatch(/hook-endpoint\.env$/)
    const joined = calls.map((c) => c.args.join(' '))
    expect(joined.some((j) => j.includes('-O forward') && j.includes('127.0.0.1:51234'))).toBe(true)
    // endpoint file written via stdin redirect
    expect(calls.some((c) => (c.stdin ?? '').includes('NODETERM_HOOK_TOKEN=tok'))).toBe(true)
    // managed script written + config merged + written back
    expect(calls.some((c) => (c.stdin ?? '').includes('--unix-socket'))).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('"hooks"'))).toBe(true)
  })
})

describe('RemoteHooks.teardown', () => {
  it('cancels the reverse forward', async () => {
    const { rh, run } = mk()
    await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 't', version: '1' })
    run.mockClear()
    await rh.teardown('p1', conn, '/s.sock')
    expect(run.mock.calls.some(([a]) => a.join(' ').includes('-O cancel'))).toBe(true)
  })
})
