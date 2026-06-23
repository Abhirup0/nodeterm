// Per-agent transcript file locators. Each resolves an on-disk transcript path from the
// sessionId captured via hooks. Filesystem + home-dir access — main process only.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveTranscriptPath } from '../transcript-reader'

// claude: ~/.claude/projects/<proj>/<sessionId>.jsonl — already implemented (searches all
// project dirs for the exact <sessionId>.jsonl).
export function locateClaude(sessionId: string): Promise<string | undefined> {
  return resolveTranscriptPath(sessionId)
}

// codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<sessionId>.jsonl — walk the tree and
// match a .jsonl filename containing the sessionId.
export async function locateCodex(sessionId: string): Promise<string | undefined> {
  const root = path.join(os.homedir(), '.codex', 'sessions')
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (e.isFile() && e.name.endsWith('.jsonl') && e.name.includes(sessionId)) return p
    }
  }
  return undefined
}

// gemini: ~/.gemini/tmp/<proj>/chats/session-*.jsonl — find the file whose first-line
// header sessionId equals the requested sessionId.
export async function locateGemini(sessionId: string): Promise<string | undefined> {
  const tmp = path.join(os.homedir(), '.gemini', 'tmp')
  let projects: string[]
  try {
    projects = await fs.promises.readdir(tmp)
  } catch {
    return undefined
  }
  for (const proj of projects) {
    const chats = path.join(tmp, proj, 'chats')
    let files: string[]
    try {
      files = await fs.promises.readdir(chats)
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const p = path.join(chats, f)
      try {
        const head = (await fs.promises.readFile(p, 'utf8')).split('\n', 1)[0]
        const o = JSON.parse(head) as { sessionId?: string }
        if (o.sessionId === sessionId) return p
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined
}
