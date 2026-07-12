import { describe, it, expect, beforeEach } from 'vitest'
import { useSshConn } from './sshConn'

beforeEach(() => {
  useSshConn.setState({ byProject: {}, autoPermByProject: {} })
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
