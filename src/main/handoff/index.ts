// Cross-agent conversation transfer (main process). Locates the source agent's native
// transcript by sessionId, renders it to full Markdown, and writes a portable handoff file
// under <cwd>/.nodeterm/. No summarization; the entire transcript is dumped.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { SESSION_ID_RE } from '../transcript-reader'
import { renderClaudeTranscript } from './render-claude'
import { renderCodexTranscript } from './render-codex'
import { renderGeminiTranscript } from './render-gemini'
import { locateClaude, locateCodex, locateGemini } from './locate'

export type HandoffResult = { filePath: string } | { error: string }

type Renderer = (raw: string) => string
type Locator = (sessionId: string) => Promise<string | undefined>

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
}): Promise<HandoffResult> {
  const { sessionId, agentId, sourceNodeId, cwd } = opts
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return { error: 'No valid session id to transfer.' }
  const render = RENDERERS[agentId]
  const locate = LOCATORS[agentId]
  if (!render || !locate) return { error: `Transfer is not supported from ${agentId}.` }

  const src = await locate(sessionId)
  if (!src) return { error: "Couldn't find the source conversation transcript." }

  let raw: string
  try {
    raw = await fs.promises.readFile(src, 'utf8')
  } catch {
    return { error: 'Failed to read the source transcript.' }
  }

  const body = render(raw)
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const header =
    `# Conversation handoff\n\n` +
    `Source agent: ${agentId}\nSource session: ${sessionId}\n\n` +
    `This is the COMPLETE prior conversation, including all tool calls and outputs.\n\n---\n\n`

  const dir = path.join(cwd && cwd.length ? cwd : os.homedir(), '.nodeterm')
  const filePath = path.join(dir, handoffFilename(sourceNodeId, ts))
  try {
    await fs.promises.mkdir(dir, { recursive: true })
    await fs.promises.writeFile(filePath, header + body, 'utf8')
  } catch {
    return { error: 'Failed to write the handoff file.' }
  }
  return { filePath }
}
