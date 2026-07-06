import { describe, it, expect } from 'vitest'
import { releasePty, type ReleasablePty } from './pty-release'

// Contract test with a stub: real node-pty is compiled against Electron's ABI and cannot load
// under vitest's node runtime, but the fd-leak fix is entirely about WHICH methods run in WHICH
// order — resume first (unblock a paused socket), then destroy (deterministic fd close) with a
// kill() fallback where destroy doesn't exist.
function stub(overrides: Partial<Record<'resume' | 'destroy' | 'kill', () => void>> = {}) {
  const calls: string[] = []
  const proc: ReleasablePty = {
    resume: overrides.resume ?? (() => calls.push('resume')),
    kill: overrides.kill ?? (() => calls.push('kill')),
    ...(overrides.destroy !== undefined || 'destroy' in overrides
      ? { destroy: overrides.destroy }
      : {})
  }
  return { proc, calls }
}

describe('releasePty', () => {
  it('resumes first, then prefers destroy (deterministic fd close) over kill', () => {
    const calls: string[] = []
    const proc: ReleasablePty = {
      resume: () => calls.push('resume'),
      kill: () => calls.push('kill'),
      destroy: () => calls.push('destroy')
    }
    releasePty(proc)
    expect(calls).toEqual(['resume', 'destroy'])
  })

  it('falls back to kill() when destroy is unavailable (winpty)', () => {
    const { proc, calls } = stub()
    releasePty(proc)
    expect(calls).toEqual(['resume', 'kill'])
  })

  it('a throwing resume() does not prevent the fd release', () => {
    const calls: string[] = []
    const proc: ReleasablePty = {
      resume: () => {
        throw new Error('socket closed')
      },
      kill: () => calls.push('kill'),
      destroy: () => calls.push('destroy')
    }
    expect(() => releasePty(proc)).not.toThrow()
    expect(calls).toEqual(['destroy'])
  })

  it('a throwing destroy/kill never propagates (process already dead)', () => {
    const proc: ReleasablePty = {
      resume: () => {},
      kill: () => {
        throw new Error('ESRCH')
      }
    }
    expect(() => releasePty(proc)).not.toThrow()
  })
})
