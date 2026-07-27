// Mirroring a node's title into its agent session as `/rename <name>`, safely.
//
// The io is injected so the gate below is unit-testable: it is the fix for a real data-loss bug,
// not a nicety. Lives outside Canvas.tsx for that reason alone.
import { isShellCommand } from '../terminal/agent-restart'

/** How long to wait for an agent CLI to take its pane before giving up on the mirror. */
export const RENAME_PUSH_ATTEMPTS = 12
export const RENAME_PUSH_RETRY_MS = 500

export interface RenamePushIo {
  paneCommand(persistKey: string): Promise<string | null>
  sendText(persistKey: string, text: string): Promise<boolean>
  /** Injected so tests don't wait in real time. */
  sleep?(ms: number): Promise<void>
}

/**
 * Push `/rename <name>` into a node's agent session — but ONLY once the agent CLI actually owns
 * the pane.
 *
 * `sendText` appends Enter, so writing while a SHELL owns the pane splices the line into whatever
 * that shell is currently reading. For a freshly opened agent node that is its own launch command
 * being typed, and the observed damage was exactly that: `claude '<long prompt>'` cut in half by
 * an interleaved `/rename …`, leaving the shell sitting at `quote>` with the agent never started
 * and the prompt lost. An agent that opens a node and renames it in the same breath — the entire
 * orchestration flow — hits that window every single time.
 *
 * So: probe the pane, and when we cannot DEMONSTRATE that a non-shell owns it, write nothing. A
 * probe that errors counts as "not demonstrated" — the asymmetry is deliberate, because an
 * unsynced session name is cosmetic while a destroyed launch is not.
 */
export async function pushSessionRename(
  io: RenamePushIo,
  nodeId: string,
  name: string
): Promise<boolean> {
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  for (let i = 0; i < RENAME_PUSH_ATTEMPTS; i++) {
    if (i > 0) await sleep(RENAME_PUSH_RETRY_MS)
    const pane = await io.paneCommand(nodeId).catch(() => null)
    if (pane && !isShellCommand(pane)) {
      void io.sendText(nodeId, `/rename ${name}`)
      return true
    }
  }
  return false
}
