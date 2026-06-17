// Session Bridge — lets two Claude Code nodes on the canvas talk to each other.
//
// Each nodeterm-spawned `claude` is launched with `--mcp-config <bridgeMcpConfigPath()>`,
// which attaches a tiny stdio MCP server (only to our sessions, never the user's normal
// `claude`). That server exposes two tools to the agent: `list_bridge_nodes` and
// `send_to_bridge`. The server self-identifies via NODETERM_NODE_ID (inherited from the
// tmux session env), reads the current link topology from topology.json, and drops outgoing
// messages as JSON files into outbox/. This main process watches outbox/, validates the link
// still exists, and injects the message into the target node's live tmux session via
// `pty.sendText` — so the receiving Claude gets it as a prompt and can reply with its own
// `send_to_bridge` call (bidirectional). A per-pair exchange counter guards against runaway
// ping-pong loops (auto-resets after a quiet period).
import fs from 'fs'
import path from 'path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { PtyManager } from './pty-manager'
import type { BridgeTopology } from '../shared/types'

let dir = ''
export function bridgeDir(): string {
  if (!dir) dir = path.join(app.getPath('userData'), 'claude-bridge')
  return dir
}
export function bridgeMcpConfigPath(): string {
  return path.join(bridgeDir(), 'mcp-config.json')
}

// The stdio MCP server, written to disk at init and run via Electron-as-Node. Self-contained
// (no deps) and uses no backticks / ${} so it can live in this template literal verbatim.
const MCP_SCRIPT = `// nodeterm bridge MCP server (auto-generated — do not edit).
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

var NODE_ID = process.env.NODETERM_NODE_ID || ''
var DIR = process.env.NODETERM_BRIDGE_DIR || ''
var TOPOLOGY = path.join(DIR, 'topology.json')
var OUTBOX = path.join(DIR, 'outbox')

function linkedNodes() {
  try {
    var all = JSON.parse(fs.readFileSync(TOPOLOGY, 'utf-8'))
    return Array.isArray(all[NODE_ID]) ? all[NODE_ID] : []
  } catch (e) {
    return []
  }
}

var TOOLS = [
  {
    name: 'list_bridge_nodes',
    description: 'List the other Claude sessions this session is linked to on the nodeterm canvas. Call this before send_to_bridge to discover valid targets (by name or id).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'send_to_bridge',
    description: 'Send a message to a linked Claude session (a node connected to this one by a bridge edge on the canvas). The recipient receives it as a prompt and can reply with its own send_to_bridge call. Use it to ask another session a question or to hand off work.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name or id of a linked node (see list_bridge_nodes). Optional when exactly one node is linked.' },
        message: { type: 'string', description: 'The message to send.' }
      },
      required: ['message'],
      additionalProperties: false
    }
  }
]

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\\n') }
function reply(id, res) { send({ jsonrpc: '2.0', id: id, result: res }) }
function fail(id, code, message) { send({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }) }
function text(t) { return { content: [{ type: 'text', text: t }] } }

function callTool(name, args) {
  if (name === 'list_bridge_nodes') {
    var nodes = linkedNodes()
    if (!nodes.length) return text('No linked nodes. Draw a bridge edge from this Claude node to another on the canvas first.')
    return text('Linked nodes:\\n' + nodes.map(function (n) { return '- ' + n.title + ' (id: ' + n.id + ')' }).join('\\n'))
  }
  if (name === 'send_to_bridge') {
    var message = String((args && args.message) || '').trim()
    if (!message) return text('Error: message is required.')
    var nodes = linkedNodes()
    if (!nodes.length) return text('Error: this session has no linked nodes.')
    var target = args && args.target ? String(args.target) : ''
    var match = null
    if (target) {
      var q = target.toLowerCase()
      match = nodes.find(function (n) { return String(n.id).toLowerCase() === q || String(n.title || '').toLowerCase() === q })
    } else if (nodes.length === 1) {
      match = nodes[0]
    }
    if (!match) return text('Error: target "' + target + '" is not linked. Linked nodes: ' + nodes.map(function (n) { return n.title }).join(', ') + '.')
    try {
      fs.mkdirSync(OUTBOX, { recursive: true })
      var file = path.join(OUTBOX, Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.json')
      fs.writeFileSync(file, JSON.stringify({ from: NODE_ID, target: match.id, message: message }))
    } catch (e) {
      return text('Error: failed to queue message: ' + (e && e.message ? e.message : e))
    }
    return text('Sent to ' + match.title + '. They will receive it as a prompt and may reply via send_to_bridge.')
  }
  return null
}

var rl = readline.createInterface({ input: process.stdin })
rl.on('line', function (line) {
  var t = line.trim()
  if (!t) return
  var msg
  try { msg = JSON.parse(t) } catch (e) { return }
  var id = msg.id
  var method = msg.method
  var params = msg.params || {}
  if (method === 'initialize') {
    reply(id, { protocolVersion: params.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'bridge', version: '1.0.0' } })
  } else if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
  } else if (method === 'tools/call') {
    var r = callTool(params.name, params.arguments || {})
    if (r) reply(id, r)
    else fail(id, -32601, 'Unknown tool')
  } else if (method === 'ping') {
    reply(id, {})
  } else if (id !== undefined && method) {
    reply(id, {})
  }
})
`

function writeServerFiles(): void {
  const d = bridgeDir()
  fs.mkdirSync(path.join(d, 'outbox'), { recursive: true })
  const scriptPath = path.join(d, 'bridge-mcp.mjs')
  fs.writeFileSync(scriptPath, MCP_SCRIPT)
  const config = {
    mcpServers: {
      bridge: {
        type: 'stdio',
        command: process.execPath,
        args: [scriptPath],
        env: { ELECTRON_RUN_AS_NODE: '1', NODETERM_BRIDGE_DIR: d }
      }
    }
  }
  fs.writeFileSync(bridgeMcpConfigPath(), JSON.stringify(config, null, 2))
}

let topology: BridgeTopology = {}

// Loop guard: cap how many messages a single pair of nodes may exchange before we pause,
// auto-resetting once they've been quiet (a fresh conversation).
const MAX_EXCHANGES = 40
const RESET_AFTER_MS = 60_000
const pairCounts = new Map<string, { count: number; last: number }>()
const pairKey = (a: string, b: string) => [a, b].sort().join('::')

/** Single-line, awareness-carrying wrapper injected into the receiving session. */
function formatBridge(fromTitle: string, message: string): string {
  const clean = message.replace(/\r?\n+/g, ' ').trim()
  return `[Bridge message from "${fromTitle}"]: ${clean}  (To reply, use the send_to_bridge tool with target "${fromTitle}".)`
}

export function initBridge(win: BrowserWindow, pty: PtyManager): void {
  const d = bridgeDir()
  const outbox = path.join(d, 'outbox')
  try {
    writeServerFiles()
    for (const f of fs.readdirSync(outbox)) fs.rmSync(path.join(outbox, f), { force: true })
    fs.writeFileSync(path.join(d, 'topology.json'), '{}')
  } catch (e) {
    console.error('[bridge] setup failed', e)
    return
  }

  ipcMain.handle(IPC.bridgeConfigPath, () => bridgeMcpConfigPath())
  ipcMain.handle(IPC.bridgeSetTopology, (_e, t: BridgeTopology) => {
    topology = t && typeof t === 'object' ? t : {}
    try {
      fs.writeFileSync(path.join(d, 'topology.json'), JSON.stringify(topology))
    } catch {
      // ignore — the MCP server tolerates a missing/unreadable topology
    }
  })

  const handleFile = (file: string): void => {
    const full = path.join(outbox, file)
    let raw: string
    try {
      raw = fs.readFileSync(full, 'utf-8')
    } catch {
      return // already consumed (fs.watch can fire twice)
    }
    fs.rmSync(full, { force: true })
    let msg: { from?: string; target?: string; message?: string }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    const from = msg.from || ''
    const target = msg.target || ''
    const message = (msg.message || '').toString()
    if (!from || !target || !message) return
    // The link must still exist (the agent could reference a since-removed edge).
    if (!(topology[from] || []).some((n) => n.id === target)) return
    // from's display title, as known by the target's neighbor list.
    const fromTitle = (topology[target] || []).find((n) => n.id === from)?.title || from

    const key = pairKey(from, target)
    const now = Date.now()
    const pc = pairCounts.get(key)
    const count = pc && now - pc.last < RESET_AFTER_MS ? pc.count + 1 : 1
    pairCounts.set(key, { count, last: now })

    const post = (stopped: boolean) => {
      if (!win.isDestroyed())
        win.webContents.send(IPC.bridgeMessage, {
          from,
          to: target,
          fromTitle,
          message,
          count,
          max: MAX_EXCHANGES,
          stopped
        })
    }
    if (count > MAX_EXCHANGES) {
      post(true) // paused — let the UI flag the runaway loop
      return
    }
    pty.sendText(target, formatBridge(fromTitle, message))
    post(false)
  }

  try {
    fs.watch(outbox, (_evt, file) => {
      if (file) setTimeout(() => handleFile(file.toString()), 10)
    })
  } catch (e) {
    console.error('[bridge] watch failed', e)
  }
}
