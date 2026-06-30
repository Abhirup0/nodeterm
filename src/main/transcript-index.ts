// Background index of all Claude session transcripts under ~/.claude/projects. Built on
// launch + refreshed every 5 min, incrementally by mtime, and persisted to userData so a
// relaunch doesn't cold re-scan. Search runs in-memory over the index. Read-only and local.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app } from 'electron'
import { SESSION_ID_RE } from './transcript-reader'
import {
  extractEntryFields,
  planRefresh,
  searchEntries,
  type ScanFile,
  type TranscriptIndexEntry,
  type TranscriptHit
} from './transcript-index-core'

export const TRANSCRIPT_INDEX_REFRESH_MS = 5 * 60 * 1000
const READ_CAP_BYTES = 5 * 1024 * 1024 // mirror transcript-reader: never read more than the tail

let entries: TranscriptIndexEntry[] = []
let timer: NodeJS.Timeout | undefined

function indexFilePath(): string {
  return path.join(app.getPath('userData'), 'transcript-index.json')
}

function projectsRoot(): string {
  return path.join(os.homedir(), '.claude', 'projects')
}

// Walk ~/.claude/projects/*/ for <sessionId>.jsonl, returning {sessionId, path, mtime}.
async function scanTranscripts(): Promise<ScanFile[]> {
  const root = projectsRoot()
  const out: ScanFile[] = []
  let dirs: string[]
  try {
    dirs = await fs.promises.readdir(root)
  } catch {
    return out
  }
  for (const d of dirs) {
    let files: string[]
    try {
      files = await fs.promises.readdir(path.join(root, d))
    } catch {
      continue
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue
      const sessionId = f.slice(0, -'.jsonl'.length)
      if (!SESSION_ID_RE.test(sessionId)) continue
      const p = path.join(root, d, f)
      try {
        const st = await fs.promises.stat(p)
        out.push({ sessionId, transcriptPath: p, mtime: Math.floor(st.mtimeMs) })
      } catch {
        /* skip */
      }
    }
  }
  return out
}

async function readTail(filePath: string): Promise<string> {
  try {
    const st = await fs.promises.stat(filePath)
    if (st.size > READ_CAP_BYTES) {
      const fd = await fs.promises.open(filePath, 'r')
      try {
        const { buffer } = await fd.read({
          position: st.size - READ_CAP_BYTES,
          length: READ_CAP_BYTES,
          buffer: Buffer.alloc(READ_CAP_BYTES)
        })
        const s = buffer.toString('utf8')
        const nl = s.indexOf('\n')
        return nl >= 0 ? s.slice(nl + 1) : s
      } finally {
        await fd.close()
      }
    }
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return ''
  }
}

function loadPersisted(): TranscriptIndexEntry[] {
  try {
    const raw = fs.readFileSync(indexFilePath(), 'utf8')
    const data = JSON.parse(raw)
    return Array.isArray(data) ? (data as TranscriptIndexEntry[]) : []
  } catch {
    return []
  }
}

async function persist(): Promise<void> {
  try {
    await fs.promises.writeFile(indexFilePath(), JSON.stringify(entries), 'utf8')
  } catch {
    /* best-effort */
  }
}

async function refresh(): Promise<void> {
  const scan = await scanTranscripts()
  const { toRead, keep } = planRefresh(entries, scan)
  // Only persist when the index actually changed (new/updated entries or dropped ones).
  const changed = toRead.length > 0 || keep.length !== entries.length
  const fresh: TranscriptIndexEntry[] = [...keep]
  for (const f of toRead) {
    const text = await readTail(f.transcriptPath)
    const { cwd, title, text: body } = extractEntryFields(text)
    fresh.push({
      sessionId: f.sessionId,
      transcriptPath: f.transcriptPath,
      cwd,
      mtime: f.mtime,
      title,
      text: body
    })
  }
  entries = fresh
  if (changed) await persist()
}

export function searchTranscripts(query: string): TranscriptHit[] {
  return searchEntries(entries, query)
}

export function initTranscriptIndex(): void {
  entries = loadPersisted()
  void refresh()
  timer = setInterval(() => void refresh(), TRANSCRIPT_INDEX_REFRESH_MS)
  if (timer.unref) timer.unref()
}
