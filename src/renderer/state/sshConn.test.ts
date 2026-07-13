import { describe, it, expect, beforeEach } from 'vitest'
import { useSshConn } from './sshConn'

beforeEach(() => {
  useSshConn.setState({ byProject: {}, autoPermByProject: {}, remoteClaudeVersionByProject: {} })
})

// If a project's SSH server gets repointed to a DIFFERENT host whose claude CLI is older, the
// previous host's cached `true` must not survive the disconnect — otherwise a Claude node created
// before the new probe lands launches `--permission-mode auto` against a CLI that exits 1 on it
// (dead node). A `disconnected` / `reconnecting` status must drop the cached answer so the window
// degrades to "unknown ⇒ bare command" (fail-open), not stale `true`.
describe('useSshConn — auto-permission-mode cache invalidation on disconnect', () => {
  it('stops reporting auto-supported once invalidated after a disconnected status', () => {
    const s = useSshConn.getState()
    s.setConn('p1', { controlPath: '/tmp/cm', claudeAutoPermissionMode: true })
    expect(s.supportsAutoPermissionMode('p1')).toBe(true)

    s.invalidateAutoPermissionMode('p1')

    expect(useSshConn.getState().supportsAutoPermissionMode('p1')).toBe(false)
  })

  it('stops reporting auto-supported once invalidated after a reconnecting status', () => {
    const s = useSshConn.getState()
    s.setConn('p1', { controlPath: '/tmp/cm', claudeAutoPermissionMode: true })
    expect(s.supportsAutoPermissionMode('p1')).toBe(true)

    // Same invalidation path is used for 'reconnecting' as for 'disconnected' — a repointed host
    // may still be mid-reconnect when a launch happens, and the stale answer must already be gone.
    s.invalidateAutoPermissionMode('p1')

    expect(useSshConn.getState().supportsAutoPermissionMode('p1')).toBe(false)
  })

  it('does not disturb other projects’ cached answers', () => {
    const s = useSshConn.getState()
    s.setConn('p1', { controlPath: '/tmp/cm1', claudeAutoPermissionMode: true })
    s.setConn('p2', { controlPath: '/tmp/cm2', claudeAutoPermissionMode: true })

    s.invalidateAutoPermissionMode('p1')

    expect(useSshConn.getState().supportsAutoPermissionMode('p1')).toBe(false)
    expect(useSshConn.getState().supportsAutoPermissionMode('p2')).toBe(true)
  })

  it('keeps the connection coordinates (controlPath etc.) — only the auto-perm answer is dropped', () => {
    const s = useSshConn.getState()
    s.setConn('p1', { controlPath: '/tmp/cm', claudeAutoPermissionMode: true })

    s.invalidateAutoPermissionMode('p1')

    // Unlike clear() (used on project delete), invalidation must not wipe the live conn info —
    // a reconnect on the same project still needs it until setConn() overwrites it.
    expect(useSshConn.getState().getControlPath('p1')).toBe('/tmp/cm')
  })
})

// The tab menu's Auto hint needs THREE states, not the boolean gate: 'unknown' (not probed yet /
// disconnected) reads differently from 'no' (probed: old CLI or claude missing). The launch gate
// (`supportsAutoPermissionMode`) stays boolean and conservative.
describe('useSshConn — tri-state probe answer + remote version (tab-menu hint)', () => {
  it('answers unknown before any probe, no/yes after, unknown again after invalidation', () => {
    const s = useSshConn.getState()
    expect(s.autoPermAnswer('p1')).toBe('unknown')

    s.setClaudeAutoPermissionMode('p1', false, '2.0.30 (Claude Code)')
    expect(useSshConn.getState().autoPermAnswer('p1')).toBe('no')

    s.setClaudeAutoPermissionMode('p1', true, '2.1.90 (Claude Code)')
    expect(useSshConn.getState().autoPermAnswer('p1')).toBe('yes')

    s.invalidateAutoPermissionMode('p1')
    expect(useSshConn.getState().autoPermAnswer('p1')).toBe('unknown')
  })

  it('records the probed version, including null for "claude not found"', () => {
    const s = useSshConn.getState()
    expect(s.getRemoteClaudeVersion('p1')).toBeUndefined()

    s.setClaudeAutoPermissionMode('p1', false, null)
    expect(useSshConn.getState().getRemoteClaudeVersion('p1')).toBeNull()

    s.setClaudeAutoPermissionMode('p1', true, '2.1.90 (Claude Code)')
    expect(useSshConn.getState().getRemoteClaudeVersion('p1')).toBe('2.1.90 (Claude Code)')
  })

  it('invalidation drops the cached version along with the answer (repointed host)', () => {
    const s = useSshConn.getState()
    s.setClaudeAutoPermissionMode('p1', false, '2.0.30 (Claude Code)')

    s.invalidateAutoPermissionMode('p1')

    expect(useSshConn.getState().getRemoteClaudeVersion('p1')).toBeUndefined()
  })

  it('setConn carries a reused connection’s probe answer + version', () => {
    const s = useSshConn.getState()
    s.setConn('p1', {
      controlPath: '/tmp/cm',
      claudeAutoPermissionMode: true,
      remoteClaudeVersion: '2.1.90 (Claude Code)'
    })

    expect(useSshConn.getState().autoPermAnswer('p1')).toBe('yes')
    expect(useSshConn.getState().getRemoteClaudeVersion('p1')).toBe('2.1.90 (Claude Code)')
  })
})
