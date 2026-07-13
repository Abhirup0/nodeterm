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
    await revoker.revoke('peerKey')

    expect(isPinned(store, 'peerKey')).toBe(false) // unpinned on disk
    expect(killed).toEqual(['peerKey']) // hook fired exactly once, with the peer id
    // Unpin must be PERSISTED before the live session is cut, so a reconnect racing the kill is
    // already refused by the pin check. (Unpin alone would leave the open socket fully privileged.)
    expect(order).toEqual(['save', 'onRevoke'])
  })

  it('still fires the kill hook even if the key was never pinned (defensive)', async () => {
    const killed: string[] = []
    const revoker = createRevoker({
      load: async () => ({ pubkeys: [] }),
      save: async () => {},
      onRevoke: (id) => killed.push(id)
    })
    await revoker.revoke('ghost')
    expect(killed).toEqual(['ghost']) // a live-but-unpinned session must still be killable
  })

  it('fires the kill hook even when persistence fails (the kill must not depend on the disk)', async () => {
    const killed: string[] = []
    const revoker = createRevoker({
      load: async () => pinDevice({ pubkeys: [] }, 'peerKey'),
      save: async () => {
        throw new Error('disk full')
      },
      onRevoke: (id) => killed.push(id)
    })
    await expect(revoker.revoke('peerKey')).resolves.toBeUndefined()
    expect(killed).toEqual(['peerKey'])
  })
})
