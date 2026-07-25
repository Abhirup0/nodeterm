import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentRestartFn,
  exitSequence,
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
})

describe('agent restart registry', () => {
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
