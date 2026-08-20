import { useProjects } from '../state/projects'
import { useDrivingLease } from '../state/browserLease'

/**
 * The "…is driving" chip (S8 PR 6 of #112, @Corvin): shown on a browser node header (and in the
 * kanban card modal) the whole time an agent holds a control lease on it — plus a short linger so a
 * burst of fast verbs reads as one continuous state. It carries the one obvious Stop.
 *
 * Decision 4: this is ALWAYS ON. There is deliberately no setting that hides it and none to add — a
 * user cannot be driving-blind by preference. It is not gated on `agentBrowserControl` either: that
 * switch decides whether an agent MAY drive; once one IS driving, the badge is unconditional.
 */

/** Presentational only — no store, so it renders in isolation under test. `ownerTitle` is the
 *  VERIFIED owner node's title (resolved from the ledger's `ownerNodeId`, never a caller label). */
export function BrowserDrivingChip({
  ownerTitle,
  onStop
}: {
  ownerTitle: string
  onStop: () => void
}): React.JSX.Element {
  return (
    <span className="term-node__status term-node__status--driven nodrag" role="status">
      <span className="term-node__status-dot" />
      <span className="browser-driving__label">{ownerTitle} is driving</span>
      <button
        className="browser-driving__stop"
        title="Stop agent control of this browser node"
        onClick={(e) => {
          e.stopPropagation()
          onStop()
        }}
      >
        Stop
      </button>
    </span>
  )
}

/**
 * The node/modal container: reads the live lease for `nodeId`, resolves the owner's title, and wires
 * Stop to main (which detaches the debugger + drops the ledger entry — a real revocation, never a
 * hide). Renders nothing when the node is not being driven.
 */
export function BrowserDrivingIndicator({ nodeId }: { nodeId: string }): React.JSX.Element | null {
  const lease = useDrivingLease(nodeId)
  const ownerTitle = useProjects((s) => {
    if (!lease) return ''
    for (const p of s.projects) {
      const owner = p.nodes.find((n) => n.id === lease.ownerNodeId)
      if (owner) return owner.title || lease.ownerNodeId
    }
    // The owner is gone from every canvas (closed/restarted) but the lease has not yet been
    // revoked: name it by id rather than blanking the chip.
    return lease.ownerNodeId
  })
  if (!lease) return null
  return (
    <BrowserDrivingChip ownerTitle={ownerTitle} onStop={() => window.nodeTerminal.browser.stop(nodeId)} />
  )
}
