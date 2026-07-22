import { describe, expect, it, vi } from 'vitest'
import { RemoteHooks } from './remote-hooks'

const conn = { host: 'h', user: 'u' }

function mk(opts: { verifyAnswers?: string[] } = {}) {
  const calls: { args: string[]; stdin?: string }[] = []
  // Tunnel-verify curl answers, consumed in order (default: healthy on the first try).
  const verifyAnswers = [...(opts.verifyAnswers ?? ['204'])]
  const run = vi.fn(async (args: string[], stdin?: string) => {
    calls.push({ args, stdin })
    const joined = args.join(' ')
    // resolve the remote $HOME probe → absolute remote paths build from this.
    if (joined.includes('$HOME')) return { code: 0, stdout: '/home/u' }
    if (joined.includes('cat /home/u/.claude/settings.json')) return { code: 0, stdout: '{}' }
    // the end-to-end tunnel verification curl (runs in ARGS, unlike the script's stdin curl).
    if (joined.includes('%{http_code}')) return { code: 0, stdout: verifyAnswers.shift() ?? '204' }
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

  it('verifies the tunnel end-to-end and heals a stale forward with one rebind', async () => {
    // First verify sees a dead target (a reused live-orphan master serving a previous run's
    // forward — the field case that killed remote statuses for hours); the rebind fixes it.
    const { rh, calls } = mk({ verifyAnswers: ['000', '204'] })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
    const joined = calls.map((c) => c.args.join(' '))
    expect(joined.filter((j) => j.includes('-O forward')).length).toBe(2)
    // The retry clears our own possibly-registered spec before rebinding.
    expect(joined.some((j) => j.includes('-O cancel'))).toBe(true)
    // The verify curl runs on the HOST through the sock with the fresh token.
    expect(joined.some((j) => j.includes('--unix-socket') && j.includes('x-nodeterm-hook-token: tok'))).toBe(true)
  })

  it('refuses to advertise a tunnel that never verifies — no endpoint file, null result', async () => {
    const { rh, calls } = mk({ verifyAnswers: ['000', '000'] })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res).toBeNull()
    // The endpoint file must NOT be written: sessions would source a socket that answers nothing.
    expect(calls.map((c) => c.args.join(' ')).some((j) => j.includes('hook-endpoint-p1.env'))).toBe(false)
  })

  it('a failed -O forward bind is retried, never trusted', async () => {
    const calls: { args: string[] }[] = []
    let forwards = 0
    const run = vi.fn(async (args: string[]) => {
      calls.push({ args })
      const joined = args.join(' ')
      if (joined.includes('$HOME')) return { code: 0, stdout: '/home/u' }
      if (joined.includes('-O forward')) return { code: ++forwards === 1 ? 1 : 0, stdout: '' }
      if (joined.includes('%{http_code}')) return { code: 0, stdout: '204' }
      if (joined.includes('cat /home/u/.claude/settings.json')) return { code: 0, stdout: '{}' }
      return { code: 0, stdout: '' }
    })
    const rh = new RemoteHooks({ run })
    const res = await rh.setup('p1', conn, '/s.sock', { port: 51234, token: 'tok', version: '1' })
    expect(res?.endpointPath).toBe('/home/u/.nodeterm/hook-endpoint-p1.env')
    expect(forwards).toBe(2)
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

describe('RemoteHooks.installCanvasControl', () => {
  const isWriteTo = (args: string[], p: string) => args.join(' ').includes('cat > ') && args.join(' ').includes(p)

  it('writes an executable shim + the skill, and merges the codex/gemini/opencode blocks', async () => {
    const { rh, calls } = mk()
    await rh.installCanvasControl(conn, '/s.sock', '/home/u')
    const joined = calls.map((c) => c.args.join(' '))
    // The shim must land executable: the skill tells the agent to run it via `sh <path>`, but the
    // instruction blocks and a user's own habits may exec it directly.
    expect(joined.some((j) => j.includes('cat > \'/home/u/.nodeterm/nodeterm.sh\'') && j.includes('chmod 755'))).toBe(true)
    // It is the POSIX shim, NOT the retired Electron-as-Node one — nothing may reference a local
    // interpreter path, which is exactly what made the old CLI unusable off the desktop.
    const shim = calls.find((c) => isWriteTo(c.args, '/home/u/.nodeterm/nodeterm.sh'))?.stdin ?? ''
    expect(shim).toContain('#!/bin/sh')
    expect(shim).toContain('--unix-socket')
    expect(shim).not.toContain('ELECTRON_RUN_AS_NODE')
    // The skill points at the REMOTE shim path (a desktop path would resolve to nothing here).
    const skill = calls.find((c) => isWriteTo(c.args, '/home/u/.claude/skills/manage-nodeterm-canvas/SKILL.md'))?.stdin ?? ''
    expect(skill).toContain('name: manage-nodeterm-canvas')
    expect(skill).toContain('sh "/home/u/.nodeterm/nodeterm.sh"')
    // codex/gemini get the marker block; opencode's path is expanded by the REMOTE shell, since
    // the desktop's XDG_CONFIG_HOME says nothing about the host's.
    expect(joined.some((j) => j.includes('/home/u/.codex/AGENTS.md'))).toBe(true)
    expect(joined.some((j) => j.includes('/home/u/.gemini/GEMINI.md'))).toBe(true)
    expect(joined.some((j) => j.includes('${XDG_CONFIG_HOME:-/home/u/.config}/opencode/AGENTS.md'))).toBe(true)
    expect(calls.some((c) => (c.stdin ?? '').includes('nodeterm:manage-canvas:start'))).toBe(true)
    // no unexpanded tilde survives in any remote path.
    expect(joined.some((j) => j.includes('~/'))).toBe(false)
  })

  it('preserves existing instruction-file content and rewrites its own block only', async () => {
    const existing = '# my notes\n\n<!-- nodeterm:manage-canvas:start -->\nSTALE\n<!-- nodeterm:manage-canvas:end -->\n'
    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      const joined = args.join(' ')
      if (joined.includes('.codex/AGENTS.md') && !joined.includes('cat >')) return { code: 0, stdout: existing }
      return { code: 0, stdout: '' }
    })
    await new RemoteHooks({ run }).installCanvasControl(conn, '/s.sock', '/home/u')
    const write = calls.find((c) => isWriteTo(c.args, '/home/u/.codex/AGENTS.md'))
    expect(write?.stdin).toContain('# my notes')
    expect(write?.stdin).not.toContain('STALE')
    expect(write?.stdin).toContain('nodeterm canvas')
  })

  it('skips the write when the block is already current (idempotent reconnects)', async () => {
    // A connect happens on every app start and every reconnect; rewriting an unchanged file each
    // time would churn the user's instruction files (and their mtimes) for nothing.
    const first = mk()
    await first.rh.installCanvasControl(conn, '/s.sock', '/home/u')
    const merged = first.calls.find((c) => c.args.join(' ').includes('cat > \'/home/u/.gemini/GEMINI.md\''))?.stdin ?? ''
    expect(merged).toBeTruthy()

    const calls: { args: string[]; stdin?: string }[] = []
    const run = vi.fn(async (args: string[], stdin?: string) => {
      calls.push({ args, stdin })
      const joined = args.join(' ')
      if (joined.includes('.gemini/GEMINI.md') && !joined.includes('cat >')) return { code: 0, stdout: merged }
      return { code: 0, stdout: '' }
    })
    await new RemoteHooks({ run }).installCanvasControl(conn, '/s.sock', '/home/u')
    expect(calls.some((c) => isWriteTo(c.args, '/home/u/.gemini/GEMINI.md'))).toBe(false)
  })

  it('installs the skill into a remote managed-account config dir', async () => {
    // claude resolves user skills relative to CLAUDE_CONFIG_DIR, so an account session never sees
    // ~/.claude/skills — the same gap installIntoAccountDir exists for on the hook side.
    const { rh, calls } = mk()
    await rh.installCanvasSkillIntoAccountDir(conn, '/s.sock', '/home/u', 'acc-1')
    const target = '/home/u/.nodeterm/claude-accounts/acc-1/skills/manage-nodeterm-canvas/SKILL.md'
    expect(calls.some((c) => isWriteTo(c.args, target))).toBe(true)
    // the shim is (re)written too — installCanvasControl may have failed open earlier.
    expect(calls.some((c) => isWriteTo(c.args, '/home/u/.nodeterm/nodeterm.sh'))).toBe(true)
  })

  it('fails open when the remote runner throws', async () => {
    const run = vi.fn(async () => {
      throw new Error('ssh died')
    })
    await expect(new RemoteHooks({ run }).installCanvasControl(conn, '/s.sock', '/home/u')).resolves.toBeUndefined()
  })
})
