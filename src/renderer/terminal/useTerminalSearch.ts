import { useEffect, useMemo, useState } from 'react'
import type { TranscriptLine } from '@shared/types'

export interface SearchSnippet {
  source: 'terminal' | 'claude'
  role?: 'user' | 'assistant' | 'tool'
  text: string
}

interface Args {
  nodeId: string
  sessionId: string | undefined
  /** The node's working directory — durable fallback for resolving the transcript. */
  cwd: string | undefined
  /** Whether this node has a readable Claude transcript (gated on hasUsage capability). */
  searchTranscript: boolean
  open: boolean
  /** Fallback content source (live xterm buffer text) when tmux capture is unavailable. */
  readBuffer: () => string
}

export interface TerminalSearch {
  query: string
  setQuery: (q: string) => void
  matchCount: number
  matchIndex: number // 1-based for display; 0 when no matches
  current: SearchSnippet | null
  next: () => void
  prev: () => void
}

export function useTerminalSearch({
  nodeId,
  sessionId,
  cwd,
  searchTranscript,
  open,
  readBuffer
}: Args): TerminalSearch {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0) // 0-based index into `matches`
  const [source, setSource] = useState<SearchSnippet[]>([])

  // Build the snapshot index when the bar opens; clear it when it closes.
  useEffect(() => {
    if (!open) {
      setSource([])
      setQuery('')
      setCursor(0)
      return
    }
    let cancelled = false
    void (async () => {
      const lines: SearchSnippet[] = []
      let captured = ''
      try {
        captured = await window.nodeTerminal.pty.capture(nodeId, true)
      } catch {
        captured = ''
      }
      if (!captured) captured = readBuffer()
      for (const t of captured.split('\n')) lines.push({ source: 'terminal', text: t })
      // Search the full Claude transcript for agent nodes. Resolved by sessionId when known,
      // else by cwd (durable) — so it works even when no live hook event set the sessionId.
      if (searchTranscript) {
        try {
          const tr: TranscriptLine[] = await window.nodeTerminal.claude.readTranscript(
            sessionId,
            cwd
          )
          for (const l of tr) {
            for (const t of l.text.split('\n')) lines.push({ source: 'claude', role: l.role, text: t })
          }
        } catch {
          // transcript unavailable — fall back to terminal buffer only
        }
      }
      if (!cancelled) setSource(lines)
    })()
    return () => {
      cancelled = true
    }
    // readBuffer must be stable (useCallback in the caller) to avoid rebuilds.
  }, [open, nodeId, sessionId, cwd, searchTranscript, readBuffer])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as number[]
    const out: number[] = []
    for (let i = 0; i < source.length; i++) {
      if (source[i].text.toLowerCase().includes(q)) out.push(i)
    }
    return out
  }, [query, source])

  // Reset the cursor to the first match whenever the result set changes.
  // `matches` is a fresh array on every query/source change (useMemo), so this
  // intentionally jumps back to the first match on each new search — not a bug.
  useEffect(() => {
    setCursor(0)
  }, [matches])

  const matchCount = matches.length
  const safeCursor = matchCount ? Math.min(cursor, matchCount - 1) : 0
  const current = matchCount ? source[matches[safeCursor]] : null

  return {
    query,
    setQuery,
    matchCount,
    matchIndex: matchCount ? safeCursor + 1 : 0,
    current,
    next: () => setCursor((c) => (matchCount ? (c + 1) % matchCount : 0)),
    prev: () => setCursor((c) => (matchCount ? (c - 1 + matchCount) % matchCount : 0))
  }
}
