// Pure tmux naming helpers shared by the PTY manager and the context-link backend.
// No native/electron imports, so this module is safe to import from unit tests.

export const TMUX_SOCKET = 'node-terminal'

/** Per-node tmux session name. Must stay stable — it is the persistence key. */
export function sessionName(persistKey: string): string {
  return `nt-${persistKey.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}
