// Pure core for the context-link feature: the nodeId→transcript map, the link-document
// builder, and the standalone CLI source. No electron / node-pty imports, so this module
// (and CLI_SCRIPT) are unit-testable. The electron/fs/ipc wiring lives in context-link.ts.
import type { ContextLinkInfo } from '../shared/types'
import { sessionName } from './tmux-naming'

// nodeId -> latest known transcript path, fed from the raw hook listener (see index.ts).
const nodeTranscript = new Map<string, string>()
export function setNodeTranscript(nodeId: string, _sessionId: string, transcriptPath: string): void {
  if (nodeId && transcriptPath) nodeTranscript.set(nodeId, transcriptPath)
}
export function transcriptPathOf(nodeId: string): string {
  return nodeTranscript.get(nodeId) ?? ''
}

export type TranscriptLocator = (sessionId: string, accountId?: string) => Promise<string | undefined>

/**
 * Resolve one link entry's transcript path. Claude (and legacy entries without an
 * agentId) prefer the hook-fed path; every agent falls back to its locator by
 * sessionId. Notes, unknown agents, and locator errors resolve to '' (fail open —
 * the CLI prints a clear "no transcript yet" message).
 */
export async function resolveLinkTranscript(
  link: { id: string; title?: string; agentId?: string; sessionId?: string; accountId?: string; note?: string },
  deps: { hooked: (id: string) => string; locators: Record<string, TranscriptLocator> }
): Promise<string> {
  if (link.note != null) return ''
  const agent = link.agentId ?? 'claude'
  if (agent === 'claude') {
    const hooked = deps.hooked(link.id)
    if (hooked) return hooked
  }
  const locate = deps.locators[agent]
  if (!locate || !link.sessionId) return ''
  try {
    return (await locate(link.sessionId, link.accountId)) ?? ''
  } catch {
    return ''
  }
}

const INSTR_START = '<!-- nodeterm:get-linked-context:start -->'
const INSTR_END = '<!-- nodeterm:get-linked-context:end -->'

/** Idempotently merge our marker-delimited block into a global instructions file
 *  (~/.codex/AGENTS.md, ~/.gemini/GEMINI.md). Everything outside the markers is preserved. */
export function mergeInstructionsBlock(existing: string, block: string): string {
  const full = `${INSTR_START}\n${block.trim()}\n${INSTR_END}`
  const start = existing.indexOf(INSTR_START)
  const end = existing.indexOf(INSTR_END)
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + full + existing.slice(end + INSTR_END.length)
  }
  const sep = existing.trim() ? (existing.endsWith('\n') ? '\n' : '\n\n') : ''
  return existing + sep + full + '\n'
}

/** The instructions body telling codex/gemini how to read linked-node context. */
export function buildLinkedContextInstructions(shimPath: string): string {
  return [
    '# Reading linked nodeterm nodes (get-linked-context)',
    '',
    'When you run inside a nodeterm canvas session, this node may be linked to other agent',
    'nodes (Claude, Codex or Gemini) or sticky notes by a context-link edge. You can READ a',
    "linked node's context on demand — nothing is pushed automatically:",
    '',
    '```sh',
    `sh "${shimPath}" list                        # nodes you are linked to (start here)`,
    `sh "${shimPath}" summary --node <id|title>   # last lines of its conversation`,
    `sh "${shimPath}" transcript --node <id|title>`,
    `sh "${shimPath}" terminal --node <id|title>  # its recent terminal output`,
    '```',
    '',
    'Only meaningful inside nodeterm (NODETERM_NODE_ID set) with a linked edge. If the CLI',
    'says "Not a nodeterm session" or "No linked nodes", there is nothing to read — do not retry.'
  ].join('\n')
}

export interface LinkDocEntry {
  id: string
  title: string
  cwd: string
  transcriptPath: string
  tmux: string
  /** Which agent CLI produced the transcript ('claude' | 'codex' | 'gemini') — selects the parser. */
  agent?: string
  /** Present when this entry is a sticky note: its text. Note entries have no transcript/terminal. */
  note?: string
}
export interface LinkDoc {
  self: { id: string }
  links: LinkDocEntry[]
  tmuxBin: string | null
  tmuxSocket: string
}

/** Pure: build one node's link document. Injected deps keep it unit-testable. */
export function buildLinkDoc(
  nodeId: string,
  links: ContextLinkInfo[],
  ctx: { transcriptOf: (id: string) => string; tmuxBin: string | null; tmuxSocket: string }
): LinkDoc {
  return {
    self: { id: nodeId },
    links: links.map((n) => {
      const isNote = n.note != null
      const entry: LinkDocEntry = {
        id: n.id,
        title: n.title,
        cwd: n.cwd ?? '',
        transcriptPath: isNote ? '' : ctx.transcriptOf(n.id),
        tmux: isNote ? '' : sessionName(n.id)
      }
      if (!isNote && n.agentId) entry.agent = n.agentId
      if (isNote) entry.note = n.note
      return entry
    }),
    tmuxBin: ctx.tmuxBin,
    tmuxSocket: ctx.tmuxSocket
  }
}

// The standalone CLI, written to disk by context-link.ts and run via Electron-as-Node.
// Self-contained (no deps) and uses no backticks / ${} so it can live in this template literal.
export const CLI_SCRIPT = `// nodeterm context-link CLI (auto-generated — do not edit).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

var DIR = path.dirname(fileURLToPath(import.meta.url))
var NODE_ID = process.env.NODETERM_NODE_ID || ''

function out(s) { process.stdout.write(s + '\\n') }

function loadLinks() {
  if (!NODE_ID) { out('Not a nodeterm session (NODETERM_NODE_ID unset) — nothing to read.'); process.exit(0) }
  try {
    var data = JSON.parse(fs.readFileSync(path.join(DIR, NODE_ID + '.json'), 'utf-8'))
    return data && Array.isArray(data.links) ? data : { links: [] }
  } catch (e) { return { links: [] } }
}

function pickNode(doc, want) {
  var links = doc.links
  if (!links.length) { out('No linked nodes. Draw a context-link edge from this node to another on the canvas.'); process.exit(0) }
  if (want) {
    var q = String(want).toLowerCase()
    var m = links.find(function (n) { return String(n.id).toLowerCase() === q || String(n.title || '').toLowerCase() === q })
    if (!m) { out('No linked node matches "' + want + '". Linked: ' + links.map(function (n) { return n.title }).join(', ')); process.exit(0) }
    return m
  }
  if (links.length === 1) return links[0]
  out('Several linked nodes — re-run with --node <id|title>:')
  links.forEach(function (n) { out('- ' + n.title + (n.note != null ? ' (note)' : '') + ' (id: ' + n.id + ')') })
  process.exit(0)
}

// ~/.claude/projects/<cwd with / and . -> ->/ newest .jsonl  (fallback when path unknown).
function transcriptForCwd(cwd) {
  if (!cwd) return ''
  var d = path.join(os.homedir(), '.claude', 'projects', String(cwd).replace(/[/.]/g, '-'))
  var newest = '', best = 0
  try {
    fs.readdirSync(d).forEach(function (e) {
      if (!e.endsWith('.jsonl')) return
      var p = path.join(d, e)
      try { var st = fs.statSync(p); if (st.mtimeMs > best) { best = st.mtimeMs; newest = p } } catch (e2) {}
    })
  } catch (e) {}
  return newest
}

function resolveTranscript(node) {
  if (node.transcriptPath && fs.existsSync(node.transcriptPath)) return node.transcriptPath
  if (node.agent && node.agent !== 'claude') return ''
  return transcriptForCwd(node.cwd)
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(function (c) { return c && c.type === 'text' ? (c.text || '') : '' }).filter(Boolean).join('\\n')
  return ''
}

// Flatten codex/gemini content: string, or array of parts carrying a .text field.
function flatText(c) {
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map(function (x) { return x && typeof x.text === 'string' ? x.text : '' }).filter(Boolean).join('\\n')
  return ''
}

// codex rollout line ({type:'response_item', payload}) -> 0..n display strings.
function linesFromCodex(raw) {
  var o
  try { o = JSON.parse(raw) } catch (e) { return [] }
  if (o.type !== 'response_item' || !o.payload) return []
  var p = o.payload
  var res = []
  if (p.type === 'message') {
    var role = p.role === 'user' ? 'user' : 'assistant'
    var t = flatText(p.content)
    if (t) res.push(role + ': ' + t)
  } else if (p.type === 'function_call') {
    var a = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments || '')
    res.push('  $ ' + (p.name || 'tool') + ' ' + String(a).slice(0, 200))
  } else if (p.type === 'function_call_output') {
    var s = flatText(p.output).split('\\n').slice(0, 3).join(' ').slice(0, 500)
    if (s) res.push('  = ' + s)
  }
  return res
}

// gemini chat file is event-sourced: replay $set/$push/bare-message lines, then flatten.
function linesFromGeminiFile(buf) {
  var messages = []
  buf.split('\\n').forEach(function (raw) {
    var t = raw.trim()
    if (!t) return
    var o
    try { o = JSON.parse(t) } catch (e) { return }
    if (o.$set && typeof o.$set === 'object' && Array.isArray(o.$set.messages)) { messages = o.$set.messages; return }
    if (o.$push && typeof o.$push === 'object') {
      var m = o.$push.messages
      if (Array.isArray(m)) messages = messages.concat(m)
      else if (m && typeof m === 'object') messages.push(m)
      return
    }
    if (o.content !== undefined && o.sessionId === undefined) messages.push(o)
  })
  var res = []
  messages.forEach(function (m) {
    var role = m.type === 'user' ? 'user' : (m.type === 'gemini' || m.type === 'model') ? 'assistant' : String(m.type || 'message')
    var t = flatText(m.content)
    if (t) res.push(role + ': ' + t)
  })
  return res
}

// Parse one transcript JSONL line into 0..n display strings.
function linesFrom(raw) {
  var o
  try { o = JSON.parse(raw) } catch (e) { return [] }
  var content = o.message && o.message.content
  var res = []
  if (o.type === 'assistant' && Array.isArray(content)) {
    content.forEach(function (c) {
      if (c.type === 'text' && c.text) res.push('assistant: ' + c.text)
      else if (c.type === 'tool_use') {
        var a = c.input && (c.input.command || c.input.file_path || c.input.path || c.input.pattern || c.input.description || c.input.prompt)
        res.push('  $ ' + (c.name || 'tool') + (typeof a === 'string' ? ' ' + a.slice(0, 200) : ''))
      }
    })
  } else if (o.type === 'user' && Array.isArray(content)) {
    content.forEach(function (c) {
      if (c.type === 'text' && c.text) res.push('user: ' + c.text)
      else if (c.type === 'tool_result') { var s = textOf(c.content).split('\\n').slice(0, 3).join(' ').slice(0, 500); if (s) res.push('  = ' + s) }
    })
  } else if (o.type === 'user' && typeof content === 'string') {
    res.push('user: ' + content)
  }
  return res
}

function readTranscript(node) {
  var p = resolveTranscript(node)
  if (!p) { out('"' + node.title + '" has no conversation transcript yet.'); return [] }
  var buf
  try { buf = fs.readFileSync(p, 'utf-8') } catch (e) { out('Could not read "' + node.title + '" transcript.'); return [] }
  if (node.agent === 'gemini') return linesFromGeminiFile(buf)
  var parse = node.agent === 'codex' ? linesFromCodex : linesFrom
  var lines = []
  buf.split('\\n').forEach(function (raw) { if (raw.trim()) lines.push.apply(lines, parse(raw)) })
  return lines
}

function readTerminal(doc, node) {
  if (!doc.tmuxBin) { out('Terminal capture unavailable (tmux not found).'); return }
  try {
    var o = execFileSync(doc.tmuxBin, ['-L', doc.tmuxSocket, 'capture-pane', '-p', '-t', node.tmux, '-S', '-200'], { encoding: 'utf-8' })
    out(o.replace(/\\s+$/, ''))
  } catch (e) { out('"' + node.title + '" terminal session is not running.') }
}

var argv = process.argv.slice(2)
var cmd = argv[0] || 'list'
function flag(name) { var i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }

var doc = loadLinks()
if (cmd === 'list') {
  if (!doc.links.length) { out('No linked nodes.'); process.exit(0) }
  out('Linked nodes:')
  doc.links.forEach(function (n) { out('- ' + n.title + (n.note != null ? ' (note)' : '') + ' (id: ' + n.id + ')') })
  process.exit(0)
}
var node = pickNode(doc, flag('--node'))
// Sticky notes carry their text in the link file — every command just prints it.
if (node.note != null) {
  if (cmd === 'terminal') {
    out('"' + node.title + '" is a sticky note — it has no terminal.')
  } else {
    out('=== ' + node.title + ' — note ===')
    out(node.note || '(empty note)')
  }
  process.exit(0)
}
if (cmd === 'summary') {
  var n = parseInt(flag('-n') || '15', 10) || 15
  var ls = readTranscript(node)
  out('=== ' + node.title + ' — last ' + n + ' lines ===')
  ls.slice(-n).forEach(out)
} else if (cmd === 'transcript') {
  var all = readTranscript(node)
  out('=== ' + node.title + ' — full transcript (' + all.length + ' lines) ===')
  all.forEach(out)
} else if (cmd === 'terminal') {
  out('=== ' + node.title + ' — terminal ===')
  readTerminal(doc, node)
} else {
  out('Unknown command. Use: list | summary [--node X] [-n N] | transcript [--node X] | terminal [--node X]')
}
`
