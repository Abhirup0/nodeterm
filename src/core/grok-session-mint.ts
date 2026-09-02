// Minting a grok session id that grok will actually accept.
//
// grok's `--session-id` is stricter than claude's in a way that turns OUR bug into a node that does
// not start (measured, 1.0.13): *"must be a valid UUID and must not already exist under the target
// session directory"*. Handing it an id that is already on disk is a LAUNCH ERROR, not a resume —
// grok exits, and the user sees a terminal that died instead of an agent.
//
// So the candidate is checked against what is already there before it is used. The check is split in
// two on purpose: a pure chooser that can be tested against any set, and a thin directory read.
import fs from 'fs'
import path from 'path'
import { grokEncodedCwdDirName } from './agents/grok-paths'

export { mintFreeGrokSessionId } from '../shared/agents/grok-session-mint'

/**
 * The session ids grok already has for this cwd: the directory names under
 * `<sessionsDir>/<encoded cwd>/`.
 *
 * Reads directory NAMES only — no file is opened and no session is parsed, because the question is
 * only "does this id exist". An unreadable or absent directory answers the empty set, which is the
 * honest answer for a cwd grok has never run in, and degrades to "mint freely" rather than to
 * "refuse to mint".
 */
export function listGrokSessionIds(sessionsDir: string, cwd: string): Set<string> {
  const encoded = grokEncodedCwdDirName(cwd)
  if (!encoded) return new Set()
  try {
    return new Set(
      fs
        .readdirSync(path.join(sessionsDir, encoded), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    )
  } catch {
    return new Set()
  }
}
