import { create } from 'zustand'

/**
 * A one-shot "please take the keyboard" request for a node, keyed by node id with a monotonic
 * nonce so the SAME node can be re-requested (the nonce is what a subscriber effect watches).
 *
 * Why it exists: the "go to node" paths (a sidebar session click, a notification tap) select and
 * zoom to a node but do NOT move keyboard focus into it — a terminal's xterm only takes focus on a
 * deliberate hover-dwell or click (the pan/hover guard). So after a sidebar click the canvas framed
 * the session beautifully but the first keystroke went nowhere until the user clicked or hovered the
 * terminal. This store lets the canvas hand focus straight to the target so typing works
 * immediately. A terminal that is not mounted (off-screen/virtualized) simply misses the request —
 * fail-open, never an error.
 */
export const useTerminalFocus = create<{
  /** The node whose terminal should take the keyboard, or null. */
  nodeId: string | null
  /** Bumped on every request so re-requesting the same node still fires a subscriber effect. */
  nonce: number
  /** Ask a node's terminal to take the keyboard now. */
  request(nodeId: string): void
}>((set) => ({
  nodeId: null,
  nonce: 0,
  request: (nodeId) => set((s) => ({ nodeId, nonce: s.nonce + 1 }))
}))
