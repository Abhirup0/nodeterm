// opencode hook service. Unlike claude/gemini (JSON settings merge) and codex (hooks.json +
// trust hash), opencode's hook seam is its PLUGIN system: a JS module in
// ~/.config/opencode/plugins/ whose exported hooks fire on session/tool/permission events.
// nodeterm owns one whole plugin file (marker-gated — a user's own file is never touched).
// opencode loads plugins on EVERY CLI command, so the plugin is env-gated: without the
// NODETERM_* env of a nodeterm-spawned session it returns {} and does nothing.
import fs from 'fs'
import os from 'os'
import path from 'path'

export const PLUGIN_MARKER = '// nodeterm managed plugin — do not edit (reinstalled at app launch)'

/** opencode is XDG-respecting: its config dir is $XDG_CONFIG_HOME/opencode when the env var
 *  is set (Linux/Server Edition users do this), else ~/.config/opencode. */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && path.isAbsolute(xdg)
    ? path.join(xdg, 'opencode')
    : path.join(os.homedir(), '.config', 'opencode')
}

export function pluginPath(): string {
  return path.join(opencodeConfigDir(), 'plugins', 'nodeterm-status.js')
}

/** The managed plugin body. Mirrors the managed POSIX script's wire contract exactly
 *  (see managed-script.ts + hook-server.ts):
 *  - gate on NODETERM_NODE_ID (absent outside nodeterm-spawned sessions → no-op `{}`);
 *  - per POST, re-read the NODETERM_HOOK_ENDPOINT FILE (KEY=VALUE lines) for the LIVE
 *    port/token — tmux sessions outlive the app, so env-baked coords go stale after a
 *    restart (the restart handoff); fall back to the env vars;
 *  - POST application/x-www-form-urlencoded `nodeId` + `version` + `payload` (JSON) with
 *    the x-nodeterm-hook-token header to http://127.0.0.1:<port>/hook/opencode.
 *  Payload fields are extracted defensively — the event NAME is the contract with
 *  normalizeOpencode; sessionID/role are best-effort. message.updated forwards ONLY user
 *  messages (turn start) so assistant token streaming never floods the hook server.
 *  (NODETERM_HOOK_SOCK unix-socket transport is not implemented here — desktop buildPtyEnv
 *  advertises the TCP port; if only a socket is available the plugin no-ops, fail-open.) */
export function buildOpencodePlugin(): string {
  return `${PLUGIN_MARKER}
import fs from 'node:fs'

export const NodetermStatus = async () => {
  const nodeId = process.env.NODETERM_NODE_ID
  if (!nodeId) return {}
  const live = () => {
    const conf = {
      port: process.env.NODETERM_HOOK_PORT,
      token: process.env.NODETERM_HOOK_TOKEN,
      version: process.env.NODETERM_HOOK_VERSION
    }
    try {
      const file = process.env.NODETERM_HOOK_ENDPOINT
      if (file) {
        for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
          const m = line.match(/^NODETERM_HOOK_(PORT|TOKEN|VERSION)=(.*)$/)
          if (m) conf[m[1].toLowerCase()] = m[2]
        }
      }
    } catch {}
    return conf
  }
  const post = (event, extra) => {
    try {
      const { port, token, version } = live()
      if (!port || !token) return
      const payload = JSON.stringify({ event, ...extra })
      fetch('http://127.0.0.1:' + port + '/hook/opencode', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-nodeterm-hook-token': token
        },
        body:
          'nodeId=' + encodeURIComponent(nodeId) +
          '&version=' + encodeURIComponent(version || '') +
          '&payload=' + encodeURIComponent(payload)
      }).catch(() => {})
    } catch {}
  }
  const sid = (x) =>
    (x && (x.sessionID || x.session_id || (x.session && x.session.id) || (x.info && x.info.sessionID))) || undefined
  return {
    'session.created': async (input) => post('session.created', { sessionID: sid(input) }),
    'session.idle': async (input) => post('session.idle', { sessionID: sid(input) }),
    'session.error': async (input) => post('session.error', { sessionID: sid(input) }),
    'permission.asked': async (input) => post('permission.asked', { sessionID: sid(input) }),
    'permission.replied': async (input) => post('permission.replied', { sessionID: sid(input) }),
    'tool.execute.before': async (input) => post('tool.execute.before', { sessionID: sid(input) }),
    'message.updated': async (input) => {
      const role = input && ((input.info && input.info.role) || input.role)
      if (role === 'user') post('message.updated', { sessionID: sid(input), role: 'user' })
    }
  }
}
`
}

export function installOpencodeHooks(): void {
  const p = pluginPath()
  try {
    const existing = fs.readFileSync(p, 'utf8')
    if (!existing.startsWith(PLUGIN_MARKER)) return // a user's own file — never touch it
  } catch {
    /* absent — plant it */
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, buildOpencodePlugin(), 'utf8')
}

export function removeOpencodeHooks(): void {
  const p = pluginPath()
  try {
    if (fs.readFileSync(p, 'utf8').startsWith(PLUGIN_MARKER)) fs.rmSync(p, { force: true })
  } catch {
    /* absent — nothing to remove */
  }
}
