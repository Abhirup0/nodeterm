// Pure core for agent canvas control: the verb model, request validation, and the standalone
// CLI source. No electron imports, so this module + CONTROL_CLI_SCRIPT are unit-testable.
// Electron/ipc/server wiring lives in canvas-control.ts + index.ts + hook-server.ts.

export type ControlVerb =
  | 'list'
  | 'open-terminal'
  | 'open-claude'
  | 'show-image'
  | 'show-video'
  | 'show-web'
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
  'show-image',
  'show-video',
  'show-web',
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
  return { verb: v, args }
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
  else if (!args.node && (verb === 'write' || verb === 'close')) { args.node = argv[i] }
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
