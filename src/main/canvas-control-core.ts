// Pure core for agent canvas control: the verb model, request validation, and the standalone
// CLI source. No electron imports, so this module + CONTROL_CLI_SCRIPT are unit-testable.
// Electron/ipc/server wiring lives in canvas-control.ts + index.ts + hook-server.ts.

export type ControlVerb =
  | 'list'
  | 'open-terminal'
  | 'open-claude'
  | 'open-agent'
  | 'show-image'
  | 'show-video'
  | 'show-web'
  | 'open-browser'
  | 'group'
  | 'arrange'
  | 'align'
  | 'spawn-team'
  | 'branch'
  | 'rename'
  | 'write'
  | 'close'

export interface ControlCommand {
  verb: ControlVerb
  args: Record<string, string>
}

const VERBS: ControlVerb[] = [
  'list',
  'open-terminal',
  'open-claude',
  'open-agent',
  'show-image',
  'show-video',
  'show-web',
  'open-browser',
  'group',
  'arrange',
  'align',
  'spawn-team',
  'branch',
  'rename',
  'write',
  'close'
]

const DESTRUCTIVE: ReadonlySet<ControlVerb> = new Set(['write', 'close'])

export function isDestructiveVerb(verb: ControlVerb): boolean {
  return DESTRUCTIVE.has(verb)
}

/** Validate a raw (verb, args) pair into a ControlCommand, or return an { error }. */
export function parseControlRequest(
  verb: string,
  args: Record<string, string>
): ControlCommand | { error: string } {
  if (!VERBS.includes(verb as ControlVerb)) return { error: `Unknown verb: ${verb}` }
  const v = verb as ControlVerb
  if (v === 'close' && !args.node) return { error: 'close requires --node <id>' }
  if (v === 'write' && !args.node) return { error: 'write requires --node <id>' }
  if (v === 'write' && !args.text) return { error: 'write requires --text' }
  if ((v === 'show-image' || v === 'show-video') && !args.path) {
    return { error: `${v} requires --path` }
  }
  if (v === 'show-web' && !args.url && !args.file && !args.html) {
    return { error: 'show-web requires --url, --file or --html' }
  }
  if (v === 'open-browser' && !args.url) return { error: 'open-browser requires --url' }
  if (v === 'open-agent' && !args.agent) return { error: 'open-agent requires --agent <id>' }
  if ((v === 'group' || v === 'arrange') && !args.nodes) return { error: `${v} requires --nodes <id,id>` }
  if (v === 'align' && !args.nodes) return { error: 'align requires --nodes <id,id>' }
  if (v === 'align' && !args.edge) return { error: 'align requires --edge' }
  if (v === 'spawn-team' && !args.team) return { error: 'spawn-team requires --team <json>' }
  if (v === 'branch' && !args.node) return { error: 'branch requires --node <id>' }
  if (v === 'rename' && !args.node) return { error: 'rename requires --node <id>' }
  if (v === 'rename' && !args.title) return { error: 'rename requires --title' }
  return { verb: v, args }
}

// Codex/Gemini have no skill system — canvas-control is announced to them via a
// marker-delimited block merged into ~/.codex/AGENTS.md / ~/.gemini/GEMINI.md (same
// pattern as context-link's get-linked-context block, distinct markers).
const CC_START = '<!-- nodeterm:manage-canvas:start -->'
const CC_END = '<!-- nodeterm:manage-canvas:end -->'

/** Idempotently merge the canvas-control block into a global instructions file.
 *  Everything outside the markers is preserved; an existing block is replaced. */
export function mergeCanvasControlBlock(existing: string, block: string): string {
  const full = `${CC_START}\n${block.trim()}\n${CC_END}`
  const start = existing.indexOf(CC_START)
  const end = existing.indexOf(CC_END)
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + full + existing.slice(end + CC_END.length)
  }
  const sep = existing.trim() ? (existing.endsWith('\n') ? '\n' : '\n\n') : ''
  return existing + sep + full + '\n'
}

/** The instructions body telling codex/gemini how to control the nodeterm canvas.
 *  Keep the verb list in sync with the skill template in canvas-control.ts. */
export function buildCanvasControlInstructions(shimPath: string): string {
  return [
    '# Managing the nodeterm canvas (manage-nodeterm-canvas)',
    '',
    'When you run inside a node on the nodeterm canvas, you can create and control other',
    'nodes (the CLI refuses outside a nodeterm session — do not retry there). Every node',
    'you open is connected to your node by an edge. Use this when the user asks you to open',
    'sessions/nodes, split work across agents, organize the canvas into groups, or show them',
    'an image/video/web page you produced.',
    '',
    '```sh',
    `sh "${shimPath}" <verb> [args]`,
    '```',
    '',
    'Verbs:',
    '- `list` — current nodes (id, kind, title). Start here when you need a node id.',
    '- `open-terminal [--cwd P] [--cmd C]` — open a terminal node.',
    '- `open-claude [--count N] [--cwd P] [--prompt T]` — open N Claude sessions.',
    '- `open-agent --agent claude|codex|gemini|<custom-id> [--count N] [--cwd P] [--prompt T]` — open any agent CLI.',
    '- `show-image <path>` / `show-video <path>` — open a media file as a node.',
    '- `show-web (--url U | --file P.html | --html "<...>")` — open a web viewer.',
    '- `open-browser --url U` — open a navigable browser node.',
    '- `group --nodes <id,id> [--label L]` / `arrange --nodes <id,id> [--layout grid|row|column] [--cols N]` /',
    '  `align --nodes <id,id> --edge left|right|top|bottom|hcenter|vcenter` — organize the canvas.',
    '- `spawn-team --label L --team \'[{"title":"UI","prompt":"...","agent":"claude"}]\'` — one agent per',
    '  role (max 8), arranged in a grid, wrapped in a labeled group, each connected to you.',
    '- `branch --node <id>` — branch a Claude node\'s conversation (Claude nodes only).',
    '- `rename --node <id> --title "New Name"` — rename any node (terminals, groups, stickies…).',
    '- `write --node <id> --text "..."` / `close --node <id>` — type into / close a node.',
    '  Both ask the user to confirm a dialog and may be denied.'
  ].join('\n')
}

// Standalone CLI written to disk by canvas-control.ts and run via Electron-as-Node.
// Self-contained (no deps), no backticks / ${} so it survives this template literal.
export const CONTROL_CLI_SCRIPT = `// nodeterm canvas-control CLI (auto-generated — do not edit).
import fs from 'node:fs'
import http from 'node:http'

function out(s) { process.stdout.write(s + '\\n') }
function fail(s) { process.stderr.write(s + '\\n'); process.exit(1) }

if (!process.env.NODETERM_CANVAS_CONTROL) {
  fail('Canvas control is not available in this session (not a nodeterm Claude node).')
}
var NODE_ID = process.env.NODETERM_NODE_ID || ''

// Read live port/token from the endpoint env file (survives app restarts).
function endpoint() {
  var p = process.env.NODETERM_HOOK_ENDPOINT
  var port = process.env.NODETERM_HOOK_PORT, token = process.env.NODETERM_HOOK_TOKEN
  try {
    if (p) {
      String(fs.readFileSync(p, 'utf-8')).split('\\n').forEach(function (ln) {
        var i = ln.indexOf('='); if (i < 0) return
        var k = ln.slice(0, i), val = ln.slice(i + 1)
        if (k === 'NODETERM_HOOK_PORT') port = val
        if (k === 'NODETERM_HOOK_TOKEN') token = val
      })
    }
  } catch (e) {}
  return { port: port, token: token }
}

// argv: <verb> [--flag value ...] [--text "..."]  (also: positional path for show-image/video)
var argv = process.argv.slice(2)
var verb = argv[0] || 'list'
var args = {}
for (var i = 1; i < argv.length; i++) {
  if (argv[i].slice(0, 2) === '--') { args[argv[i].slice(2)] = argv[i + 1] || ''; i++ }
  else if (!args.path && (verb === 'show-image' || verb === 'show-video')) { args.path = argv[i] }
  else if (!args.node && (verb === 'write' || verb === 'close' || verb === 'rename' || verb === 'branch')) { args.node = argv[i] }
}

var ep = endpoint()
if (!ep.port || !ep.token) fail('nodeterm control endpoint unavailable.')

var body = JSON.stringify({ nodeId: NODE_ID, args: args })
var reqOpts = {
  host: '127.0.0.1', port: Number(ep.port), method: 'POST',
  path: '/control/' + encodeURIComponent(verb),
  headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-nodeterm-hook-token': ep.token }
}
var req = http.request(reqOpts, function (res) {
  var data = ''
  res.on('data', function (c) { data += c })
  res.on('end', function () {
    var j = {}
    try { j = JSON.parse(data) } catch (e) {}
    if (res.statusCode >= 200 && res.statusCode < 300 && j.ok) {
      out(j.message || JSON.stringify(j.result || {}))
    } else {
      fail(j.error || ('control request failed (HTTP ' + res.statusCode + ')'))
    }
  })
})
req.on('error', function (e) { fail('Could not reach nodeterm: ' + e.message) })
req.write(body)
req.end()
`
