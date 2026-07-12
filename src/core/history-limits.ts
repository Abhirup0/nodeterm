// Scrollback-hydration caps + the clamp for an untrusted `lines` request. Deliberately a tiny,
// dependency-free module: BOTH `pty-manager` (which pulls in node-pty) and the pure ssh leaf
// `remote-ssh/control-master` import it, so the clamp can be enforced at the actual injection
// sink without dragging a native module into the pure builders.

// Reattach hydration caps: tmux history is the source, but an attach must not stall on a huge
// transfer (an ssh/mobile link pays for every byte, and `-e` colour codes inflate it).
export const HISTORY_LINES = 5000
export const HISTORY_MAX_BYTES = 1024 * 1024

/** Clamp an untrusted `lines` request (it crosses IPC / WS-RPC from a renderer, and ends up
 *  interpolated into a remote `tmux capture-pane -S -<n>` shell command) to a sane integer.
 *  Applied at BOTH the caller (`PtyManager.captureHistory`) and the sink
 *  (`remoteCaptureHistoryArgs`), so no future call site can build an injectable command. */
export function clampHistoryLines(lines: number): number {
  return Math.min(HISTORY_LINES, Math.max(1, Math.floor(Number(lines) || HISTORY_LINES)))
}
