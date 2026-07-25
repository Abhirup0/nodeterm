import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetAgentRestartForTests,
  agentRestartFn,
  exitSequence,
  guardConcurrentRestart,
  isShellCommand,
  performRestartResume,
  registerAgentRestart,
  restartEligibility,
  summarizeOutcomes,
  type RestartOutcome
} from './agent-restart'

describe('exitSequence', () => {
  it('knows claude and codex, refuses others', () => {
    expect(exitSequence('claude')).toBe('/exit')
    expect(exitSequence('codex')).toBe('/quit')
    expect(exitSequence('gemini')).toBeNull()
    expect(exitSequence('my-custom')).toBeNull()
  })
})

describe('isShellCommand', () => {
  it('matches plain, login-dash and path-prefixed shells', () => {
    for (const c of ['zsh', 'bash', 'sh', 'fish', '-zsh', '/bin/bash', '/usr/local/bin/fish'])
      expect(isShellCommand(c)).toBe(true)
  })
  it('rejects agents, editors and empty', () => {
    for (const c of ['claude', 'codex', 'node', 'vim', '', null, undefined])
      expect(isShellCommand(c as never)).toBe(false)
  })
})

describe('restartEligibility', () => {
  it('ok for a resumable agent with a session id in a non-working state', () => {
    expect(restartEligibility('claude', 'waiting', 'abc-123')).toEqual({ ok: true })
    expect(restartEligibility('codex', 'done', 'abc-123')).toEqual({ ok: true })
  })
  it('treats a blocked (permission prompt) session as busy — /exit would answer the prompt', () => {
    expect(restartEligibility('claude', 'blocked', 'abc')).toEqual({ ok: false, reason: 'working' })
  })
  it('flags working / missing session / non-resumable, in that priority', () => {
    expect(restartEligibility('claude', 'working', 'abc')).toEqual({ ok: false, reason: 'working' })
    expect(restartEligibility('claude', 'waiting', undefined)).toEqual({
      ok: false,
      reason: 'no-session'
    })
    expect(restartEligibility('gemini', 'waiting', 'abc')).toEqual({
      ok: false,
      reason: 'not-resumable'
    })
    expect(restartEligibility(undefined, undefined, undefined)).toEqual({
      ok: false,
      reason: 'not-resumable'
    })
  })
})

function fakeIo() {
  const written: string[] = []
  let cb: ((chunk: string) => void) | null = null
  return {
    written,
    io: {
      write(d: string) {
        written.push(d)
        // deliverCommand verifies by echo: reflect every write back immediately.
        cb?.(d)
      },
      onData(f: (chunk: string) => void) {
        cb = f
        return () => {
          cb = null
        }
      }
    }
  }
}

/** An io the shell never echoes back: deliverCommand cannot verify the line, so it sits
 *  un-submitted in the pane for its whole retry window — the state a second restart must never
 *  write into. */
function silentIo() {
  const written: string[] = []
  return {
    written,
    io: {
      write(d: string) {
        written.push(d)
      },
      onData() {
        return () => {}
      }
    }
  }
}

describe('performRestartResume', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends exit, waits for the shell, then delivers the resume command', async () => {
    const { written, io } = fakeIo()
    let pane = 'claude'
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => pane,
      timeoutMs: 6000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(250) // a few polls while the CLI is still up
    pane = 'zsh'
    await vi.advanceTimersByTimeAsync(5000)
    expect(await p).toBe('restarted')
    expect(written[0]).toBe('/exit\r')
    expect(written.join('')).toContain('claude --resume sid-1')
  })

  it('gives up without delivering when the pane never returns to a shell', async () => {
    const { written, io } = fakeIo()
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'claude',
      timeoutMs: 1000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('exit-timeout')
    expect(written.join('')).not.toContain('--resume')
  })

  it('gives up when the pane query itself never settles', async () => {
    const { written, io } = fakeIo()
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: () => new Promise<string | null>(() => {}), // wedged tmux server: never settles
      timeoutMs: 1000,
      pollMs: 100
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('exit-timeout')
    expect(written.join('')).not.toContain('--resume')
  })

  it('refuses an agent without an exit sequence', async () => {
    const { io } = fakeIo()
    expect(
      await performRestartResume({
        agentId: 'gemini',
        sessionId: 's',
        io,
        paneCommand: async () => 'zsh'
      })
    ).toBe('not-eligible')
  })

  it('refuses — without writing the exit — a session id we could never resume into', async () => {
    const { written, io } = fakeIo()
    expect(
      await performRestartResume({
        agentId: 'claude',
        sessionId: '-bad', // rejected by resumeCommand's SAFE_SESSION_ID
        io,
        paneCommand: async () => 'zsh'
      })
    ).toBe('not-eligible')
    expect(written).toEqual([]) // quitting a CLI we cannot resume would just lose the session
  })

  it('hands the delivery cancel to the caller, which stops it writing (node teardown)', async () => {
    const { written, io } = silentIo()
    let cancel: (() => void) | undefined
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'zsh',
      timeoutMs: 1000,
      pollMs: 100,
      onDelivery: (c) => {
        cancel = c
      }
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(typeof cancel).toBe('function') // handed out as the delivery STARTS, not when it ends
    const delivered = written.length
    cancel?.()
    expect(await p).toBe('restarted') // cancelling settles the delivery, and with it the restart
    await vi.advanceTimersByTimeAsync(30_000)
    // No rewrite retries, no fail-open submit: nothing more reaches the torn-down transport.
    expect(written.length).toBe(delivered)
  })

  it('resolves only once the resume line has left the pane', async () => {
    const { io } = silentIo()
    let settled = false
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'zsh',
      timeoutMs: 1000,
      pollMs: 100
    }).then((o) => {
      settled = true
      return o
    })
    await vi.advanceTimersByTimeAsync(200)
    expect(settled).toBe(false) // written, but still un-submitted through the verify retries
    await vi.advanceTimersByTimeAsync(10_000) // the last attempt submits fail-open
    expect(await p).toBe('restarted')
  })

  it('writes nothing when the session is already gone', async () => {
    const { written, io } = fakeIo()
    expect(
      await performRestartResume({
        agentId: 'claude',
        sessionId: 'sid-1',
        io,
        paneCommand: async () => 'zsh',
        isLive: () => false
      })
    ).toBe('not-eligible')
    expect(written).toEqual([])
  })

  it('reports no restart when the session dies while we wait for the shell', async () => {
    const { written, io } = fakeIo()
    let live = true
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'claude',
      timeoutMs: 5000,
      pollMs: 100,
      isLive: () => live
    })
    await vi.advanceTimersByTimeAsync(150)
    live = false // the node was deleted / its tmux session destroyed under us
    await vi.advanceTimersByTimeAsync(200)
    // Not 'exit-timeout': nothing timed out, the pane simply stopped existing — and not
    // 'restarted', which would put a phantom in the bulk summary.
    expect(await p).toBe('not-eligible')
    expect(written.join('')).not.toContain('--resume')
  })

  it('hands out no cancel when nothing was delivered', async () => {
    const { io } = fakeIo()
    const handles: Array<() => void> = []
    const p = performRestartResume({
      agentId: 'claude',
      sessionId: 'sid-1',
      io,
      paneCommand: async () => 'claude',
      timeoutMs: 1000,
      pollMs: 100,
      onDelivery: (c) => handles.push(c)
    })
    await vi.advanceTimersByTimeAsync(2000)
    expect(await p).toBe('exit-timeout')
    expect(handles).toEqual([])
  })
})

describe('guardConcurrentRestart', () => {
  // The in-flight set is module-global: a test that leaves a restart running would otherwise
  // refuse the next test's restart of the same node id.
  beforeEach(() => {
    __resetAgentRestartForTests()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('holds the node until the delivery settles, not merely until the restart resolves', async () => {
    const { written, io } = silentIo()
    const run = guardConcurrentRestart('n-overlap', () =>
      performRestartResume({
        agentId: 'claude',
        sessionId: 'sid-1',
        io,
        paneCommand: async () => 'zsh',
        timeoutMs: 1000,
        pollMs: 100
      })
    )
    const probe = guardConcurrentRestart('n-overlap', async () => 'restarted')
    const first = run()
    await vi.advanceTimersByTimeAsync(150)
    // The resume line is in the pane but NOT submitted (no echo to verify it).
    expect(written.join('')).toContain('claude --resume sid-1')
    // A second menu/bulk click landing in that window would splice `/exit` into the pending line
    // and submit `claude --resume sid-1/exit`.
    expect(await run()).toBe('not-eligible')
    expect(await probe()).toBe('not-eligible')
    expect(written.filter((w) => w === '/exit\r')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(10_000) // the fail-open submit ends the delivery
    expect(await first).toBe('restarted')
    expect(await probe()).toBe('restarted') // pane free again
  })

  it('refuses a second call while one is in flight, without running it twice', async () => {
    let runs = 0
    let release: (o: RestartOutcome) => void = () => {}
    const guarded = guardConcurrentRestart('n1', () => {
      runs += 1
      return new Promise<RestartOutcome>((r) => (release = r))
    })
    const first = guarded()
    expect(await guarded()).toBe('not-eligible') // menu + bulk hitting one node
    expect(runs).toBe(1)
    release('restarted')
    expect(await first).toBe('restarted')
    const second = guarded() // guard released once the run settled
    expect(runs).toBe(2)
    release('exit-timeout')
    expect(await second).toBe('exit-timeout')
  })

  it('guards per node, not globally', async () => {
    const pending = (): Promise<RestartOutcome> => new Promise(() => {})
    const a = guardConcurrentRestart('n1', pending)
    const b = guardConcurrentRestart('n2', async () => 'restarted')
    void a()
    expect(await b()).toBe('restarted')
  })

  it('releases the guard when the run throws', async () => {
    let runs = 0
    const guarded = guardConcurrentRestart('n3', async () => {
      runs += 1
      throw new Error('ipc died')
    })
    await expect(guarded()).rejects.toThrow('ipc died')
    await expect(guarded()).rejects.toThrow('ipc died')
    expect(runs).toBe(2)
  })
})

describe('agent restart registry', () => {
  beforeEach(() => __resetAgentRestartForTests())

  it('registers, resolves and unregisters; re-register supersedes', () => {
    const a = async (): Promise<RestartOutcome> => 'restarted'
    const un = registerAgentRestart('n1', a)
    expect(agentRestartFn('n1')).toBe(a)
    const b = async (): Promise<RestartOutcome> => 'exit-timeout'
    registerAgentRestart('n1', b)
    un() // stale unregister from the superseded registration must be inert
    expect(agentRestartFn('n1')).toBe(b)
  })

  it('drops a live registration on unregister (node unmount)', () => {
    const fn = async (): Promise<RestartOutcome> => 'restarted'
    registerAgentRestart('n2', fn)()
    expect(agentRestartFn('n2')).toBeUndefined()
  })
})

describe('summarizeOutcomes', () => {
  it('counts restarted / timeout / pre-skips into the toast line', () => {
    expect(
      summarizeOutcomes(['restarted', 'restarted', 'exit-timeout'], { working: 2, noSession: 1 })
    ).toBe('2 restarted · 1 failed (exit timeout) · 2 skipped (working) · 1 skipped (no session)')
    expect(summarizeOutcomes(['restarted'], { working: 0, noSession: 0 })).toBe('1 restarted')
  })
})
