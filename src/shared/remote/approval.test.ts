import { describe, it, expect } from 'vitest'
import { peerApprovalView } from './approval'
import { describeGrant } from './consent'

describe('peerApprovalView', () => {
  it('names the peer for the consent notice and echoes the SAS + confirm target', () => {
    const view = peerApprovalView({ id: 'peer-1', sas: '12-34-56', label: "Ayşe's Mac" })
    // The consent sentence the human must read is derived from this label via describeGrant.
    expect(view.peerLabel).toBe("Ayşe's Mac")
    expect(describeGrant(view.peerLabel)).toContain('run commands on this Mac')
    // The SAS both humans compare is in the dialog body verbatim.
    expect(view.message).toContain('12-34-56')
    // Confirm acts on THIS pending peer's id (relayHost.confirm(id)).
    expect(view.confirmId).toBe('peer-1')
  })

  it('falls back to a generic subject when no label is provided', () => {
    const view = peerApprovalView({ id: 'peer-2', sas: null })
    expect(view.peerLabel).toBe('This device')
    // A missing SAS renders as a visible placeholder, never a blank line.
    expect(view.message).toContain('— — —')
    expect(view.confirmId).toBe('peer-2')
  })
})
