// Cross-agent conversation transfer (main process). Locates the source agent's native
// transcript by sessionId, renders it to full Markdown, and writes a portable handoff file
// under <cwd>/.nodeterm/. The PRIMARY file is context-budgeted (budget.ts): a long session
// used to dump megabytes, and a target agent obeying "read the entire file" hit its own
// context ceiling, compacted, and forgot the task (field report — codex greeted with
// "What would you like to work on?"). Over-budget sessions keep the recent conversation
// verbatim + a digest of the rest, with the COMPLETE render written beside it as
// `…-full.md` for on-demand range reads.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SESSION_ID_RE } from '../../core/transcript-reader'
import { renderClaudeTranscript } from './render-claude'
import { renderCodexTranscript } from './render-codex'
import { renderGeminiTranscript } from './render-gemini'
import { budgetHandoff } from './budget'
import { locateClaude, locateCodex, locateGemini } from '../../core/handoff/locate'

export type HandoffResult = { filePath: string } | { error: string }

type Renderer = (raw: string) => string
type Locator = (sessionId: string, accountId?: string) => Promise<string | undefined>

const RENDERERS: Record<string, Renderer> = {
  claude: renderClaudeTranscript,
  codex: renderCodexTranscript,
  gemini: renderGeminiTranscript
}

const LOCATORS: Record<string, Locator> = {
  claude: locateClaude,
  codex: locateCodex,
  gemini: locateGemini
}

/** Filesystem-safe handoff filename for a node + ISO-ish timestamp. Node ids are
 *  machine-generated and safe today, but sanitize defensively so a future caller can't
 *  cause a path escape via the interpolated id. */
export function handoffFilename(nodeId: string, ts: string): string {
  const safe = nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return `handoff-${safe}-${ts}.md`
}

export async function buildHandoff(opts: {
  sessionId: string
  agentId: string
  sourceNodeId: string
  cwd?: string
  accountId?: string
}): Promise<HandoffResult> {
  const { sessionId, agentId, sourceNodeId, cwd, accountId } = opts
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { error: 'No valid session id to transfer.' }
  const render = RENDERERS[agentId]
  const locate = LOCATORS[agentId]
  if (!render || !locate) return { error: `Transfer is not supported from ${agentId}.` }

  const src = await locate(sessionId, accountId)
  if (!src) return { error: "Couldn't find the source conversation transcript." }

  let raw: string
  try {
    raw = await fs.promises.readFile(src, 'utf8')
  } catch {
    return { error: 'Failed to read the source transcript.' }
  }

  const full = render(raw)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')

  const dir = path.join(cwd && cwd.length ? cwd : os.homedir(), '.nodeterm')
  const filePath = path.join(dir, handoffFilename(sourceNodeId, ts))
  const fullPath = filePath.replace(/\.md$/, '-full.md')

  const { body, truncated } = budgetHandoff(full, undefined, fullPath)
  const header =
    `# Conversation handoff\n\n` +
    `Source agent: ${agentId}\nSource session: ${sessionId}\n\n` +
    (truncated
      ? `This is the prior conversation, condensed to fit your context (see the note below).\n\n---\n\n`
      : `This is the COMPLETE prior conversation, including all tool calls and outputs.\n\n---\n\n`)

  try {
    await fs.promises.mkdir(dir, { recursive: true })
    // The complete render goes first: if it fails, the primary must not promise a full copy.
    if (truncated) await fs.promises.writeFile(fullPath, full, 'utf8')
    await fs.promises.writeFile(filePath, header + body, 'utf8')
  } catch {
    return { error: 'Failed to write the handoff file.' }
  }
  return { filePath }
}
