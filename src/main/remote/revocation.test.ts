import { describe, it, expect } from 'vitest'
import { revoke, createRevoker, type RevocationDeps } from './revocation'
import { pinDevice, isPinned, type ApprovedDevices } from './approved-devices-core'

describe('pure revoke', () => {
  it('removes the pin (idempotent)', () => {
    const store = pinDevice({ pubkeys: [] }, 'peerKey')
    const after = revoke(store, 'peerKey')
    expect(isPinned(after, 'peerKey')).toBe(false)
    expect(revoke(after, 'peerKey')).toEqual(after) // idempotent
  })
})

describe('createRevoker: unpins AND fires the kill hook', () => {
  it('persists the unpin, then fires onRevoke(peerId) so 4c can cut the live session', async () => {
    let store: ApprovedDevices = pinDevice({ pubkeys: [] }, 'peerKey')
    const order: string[] = []
    const killed: string[] = []
    const deps: RevocationDeps = {
      load: async () => store,
      save: async (s) => {
        order.push('save')
        store = s
      },
      // Fake teardown standing in for 4c's "close relay conn + PtyManager.dropClient + presenceHub.leave".
      onRevoke: (peerId) => {
        order.push('onRevoke')
        killed.push(peerId)
      }
    }
    const revoker = createRevoker(deps)
    const result = await revoker.revoke('peerKey')

    expect(isPinned(store, 'peerKey')).toBe(false) // unpinned on disk
    expect(killed).toEqual(['peerKey']) // hook fired exactly once, with the peer id
    // Happy path reports both steps succeeded, so the UI can show a truthful "Removed".
    expect(result).toEqual({ persisted: true, killed: true })
    // Unpin must be PERSISTED before the live session is cut, so a reconnect racing the kill is
    // already refused by the pin check. (Unpin alone would leave the open socket fully privileged.)
    expect(order).toEqual(['save', 'onRevoke'])
  })

  it('still fires the kill hook even if the key was never pinned (defensive)', async () => {
    const killed: string[] = []
    const revoker = createRevoker({
      load: async () => ({ pubkeys: [] }),
      save: async () => {},
      onRevoke: (id) => { killed.push(id) }
    })
    const result = await revoker.revoke('ghost')
    expect(killed).toEqual(['ghost']) // a live-but-unpinned session must still be killable
    expect(result).toEqual({ persisted: true, killed: true })
  })

  it('fires the kill hook even when persistence fails, AND surfaces persisted:false (no false "Removed")', async () => {
    // A throwing save must NOT be reported as success: temp+rename means the OLD pinned file survives,
    // so the revoked peer could reconnect and auto-approve. The caller must see persisted:false and retry.
    const killed: string[] = []
    const revoker = createRevoker({
      load: async () => pinDevice({ pubkeys: [] }, 'peerKey'),
      save: async () => {
        throw new Error('disk full')
      },
      onRevoke: (id) => { killed.push(id) }
    })
    const result = await revoker.revoke('peerKey')
    expect(killed).toEqual(['peerKey']) // the kill still fires (immediacy) ...
    expect(result).toEqual({ persisted: false, killed: true }) // ... but the failure is REPORTED, not swallowed
  })

  it('surfaces persisted:false when load() throws (pin never removed), and still fires the kill', async () => {
    // Finding 3: a throwing load is swallowed by the same catch today. If it throws, the pin was never
    // even read, so it certainly survives — this must be persisted:false, not a silent success.
    const killed: string[] = []
    const revoker = createRevoker({
      load: async () => {
        throw new Error('read fault')
      },
      save: async () => {},
      onRevoke: (id) => { killed.push(id) }
    })
    const result = await revoker.revoke('peerKey')
    expect(killed).toEqual(['peerKey'])
    expect(result).toEqual({ persisted: false, killed: true })
  })

  it('awaits an async onRevoke and surfaces a rejecting teardown (no unhandled rejection)', async () => {
    // 4c's teardown (close relay conn → dropClient → presence leave) is async. A rejection must be
    // observable via killed:false, not dropped as an unhandled rejection with a half-torn-down socket.
    let store: ApprovedDevices = pinDevice({ pubkeys: [] }, 'peerKey')
    const revoker = createRevoker({
      load: async () => store,
      save: async (s) => {
        store = s
      },
      onRevoke: async () => {
        throw new Error('relay close failed')
      }
    })
    const result = await revoker.revoke('peerKey')
    expect(isPinned(store, 'peerKey')).toBe(false) // unpin still persisted first
    expect(result).toEqual({ persisted: true, killed: false }) // teardown failure surfaced, not swallowed
  })

  it('awaits an async onRevoke on the happy path (resolves only once the cut is real)', async () => {
    const order: string[] = []
    let store: ApprovedDevices = pinDevice({ pubkeys: [] }, 'peerKey')
    const revoker = createRevoker({
      load: async () => store,
      save: async (s) => {
        order.push('save')
        store = s
      },
      onRevoke: async () => {
        // Defer so a non-awaiting revoke() would resolve before the teardown completed.
        await Promise.resolve()
        order.push('onRevoke')
      }
    })
    const result = await revoker.revoke('peerKey')
    expect(result).toEqual({ persisted: true, killed: true })
    expect(order).toEqual(['save', 'onRevoke']) // still save-before-kill, and the kill fully completed
  })
})
