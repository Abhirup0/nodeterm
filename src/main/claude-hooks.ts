// Robust Claude Code state detection via Claude's own hooks (the same approach REF uses).
//
// We install ONE managed hook command into the user's ~/.claude/settings.json (merged,
// preserving their existing config; idempotent). The command is env-gated: it does nothing
// unless NODETERM_NODE_ID is set, so it's a no-op in the user's normal terminals and only
// activates in sessions nodeterm spawns (which set NODETERM_NODE_ID/NODETERM_HOOK_DIR via
// tmux `-e`). When active it appends the hook's JSON payload to a per-node log file; the
// main process watches that dir and forwards each event to the renderer over `claude:status`.
// Because the hook lives in the global settings, ANY `claude` run inside nodeterm (including
// one the user types by hand) is detected — not just the managed Claude Code node.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { app, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'Notification',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse'
]

// Tool names that represent a spawned subagent (the only PreToolUse/PostToolUse we forward).
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

// The single managed hook command, registered under each event above. Must stay byte-stable
// so install is idempotent and uninstall can find it. Reads the hook payload from stdin and
// appends it (Claude's payload already carries hook_event_name + session_id).
const MANAGED_CMD =
  '[ -z "$NODETERM_NODE_ID" ] && exit 0; mkdir -p "$NODETERM_HOOK_DIR" 2>/dev/null; { cat; printf "\\n"; } >> "$NODETERM_HOOK_DIR/$NODETERM_NODE_ID.log" 2>/dev/null || true'

let hookDir = ''

export function claudeHookDir(): string {
  if (!hookDir) hookDir = path.join(app.getPath('userData'), 'claude-signals')
  return hookDir
}

interface HookDef {
  hooks?: { type?: string; command?: string }[]
}

/** Merge our managed hook into ~/.claude/settings.json, preserving everything else. */
function installHooks(): void {
  const cfgPath = path.join(os.homedir(), '.claude', 'settings.json')
  let config: { hooks?: Record<string, HookDef[]>; [k: string]: unknown } = {}
  if (fs.existsSync(cfgPath)) {
    try {
      config = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'))
    } catch {
      // Don't risk corrupting an unparseable settings file.
      console.error('[claude-hooks] ~/.claude/settings.json is not valid JSON; skipping install')
      return
    }
  }
  if (!config.hooks || typeof config.hooks !== 'object') config.hooks = {}
  let changed = false
  for (const ev of CLAUDE_EVENTS) {
    const existing = config.hooks[ev]
    if (existing && !Array.isArray(existing)) continue // leave unexpected shapes alone
    const list = Array.isArray(existing) ? existing : (config.hooks[ev] = [])
    const present = list.some((d) => (d.hooks ?? []).some((h) => h.command === MANAGED_CMD))
    if (!present) {
      list.push({ hooks: [{ type: 'command', command: MANAGED_CMD }] })
      changed = true
    }
  }
  if (changed) {
    try {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true })
      fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2))
    } catch (e) {
      console.error('[claude-hooks] failed writing ~/.claude/settings.json', e)
    }
  }
}

/** Install hooks, clear stale signals, and watch for new hook events. */
export function initClaudeHooks(win: BrowserWindow): void {
  installHooks()
  const dir = claudeHookDir()
  try {
    fs.mkdirSync(dir, { recursive: true })
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.log')) fs.rmSync(path.join(dir, f), { force: true })
    }
  } catch (e) {
    console.error('[claude-hooks] signal dir setup failed', e)
    return
  }

  const offsets = new Map<string, number>()

  const scan = () => {
    let files: string[]
    try {
      files = fs.readdirSync(dir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.endsWith('.log')) continue
      const full = path.join(dir, f)
      let size: number
      try {
        size = fs.statSync(full).size
      } catch {
        continue
      }
      const prev = offsets.get(f) ?? 0
      if (size <= prev) {
        offsets.set(f, size)
        continue
      }
      let chunk = ''
      try {
        const fd = fs.openSync(full, 'r')
        const buf = Buffer.alloc(size - prev)
        fs.readSync(fd, buf, 0, buf.length, prev)
        fs.closeSync(fd)
        chunk = buf.toString('utf-8')
      } catch {
        continue
      }
      offsets.set(f, size)
      const nodeId = f.slice(0, -4)
      for (const line of chunk.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const p = JSON.parse(t) as {
            hook_event_name?: string
            session_id?: string
            notification_type?: string
            last_assistant_message?: string
            prompt?: string
            tool_name?: string
            tool_use_id?: string
            tool_input?: { subagent_type?: string; description?: string; prompt?: string }
            tool_response?: {
              status?: string
              content?: { type?: string; text?: string }[]
              totalDurationMs?: number
              totalTokens?: number
              totalToolUseCount?: number
            }
          }
          if (!p.hook_event_name || win.isDestroyed()) continue
          // Tool events flood (every Bash/Edit) — only forward subagent spawns.
          const isTool = p.hook_event_name === 'PreToolUse' || p.hook_event_name === 'PostToolUse'
          if (isTool && !SUBAGENT_TOOLS.has(p.tool_name ?? '')) continue
          const tr = p.tool_response
          const result = tr?.content
            ?.filter((c) => c.type === 'text' && c.text)
            .map((c) => c.text)
            .join('\n')
          win.webContents.send(IPC.claudeStatus, {
            nodeId,
            event: p.hook_event_name,
            sessionId: p.session_id,
            notificationType: p.notification_type,
            lastMessage: p.last_assistant_message,
            prompt: p.prompt,
            toolName: p.tool_name,
            toolUseId: p.tool_use_id,
            subagentType: p.tool_input?.subagent_type,
            taskLabel: p.tool_input?.description || p.tool_input?.prompt,
            status: tr?.status,
            durationMs: tr?.totalDurationMs,
            tokens: tr?.totalTokens,
            toolUses: tr?.totalToolUseCount,
            result
          })
        } catch {
          // partial/garbled line; ignore
        }
      }
    }
  }

  // Event-driven only (no polling): fs.watch on the dir fires on every append here, and
  // scan() reads offset-based, so each line is delivered exactly once.
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    fs.watch(dir, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(scan, 40)
    })
  } catch (e) {
    console.error('[claude-hooks] watch failed', e)
  }
}
