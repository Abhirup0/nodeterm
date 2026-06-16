// Robust Claude Code state detection via Claude's own hooks (not terminal-output parsing).
//
// We write a settings file containing only hooks and launch Claude with `--settings <file>`
// (non-invasive — it merges over the user's settings for that session only). Each hook
// command inherits the env we set on the session (NODETERM_NODE_ID / NODETERM_HOOK_DIR) and
// appends the hook's JSON payload, tagged with the event, to a per-node log file. The main
// process watches that directory and forwards each event to the renderer over `claude:status`.
import fs from 'fs'
import path from 'path'
import { app, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'

let hookDir = ''
let settingsPath = ''

export function claudeHookPaths(): { hookDir: string; settingsPath: string } {
  if (!hookDir) {
    const base = app.getPath('userData')
    hookDir = path.join(base, 'claude-signals')
    settingsPath = path.join(base, 'claude-hooks.json')
  }
  return { hookDir, settingsPath }
}

// A POSIX-shell hook command: wrap the stdin payload with the event label and append a line.
function hookCommand(event: string): string {
  return (
    `mkdir -p "$NODETERM_HOOK_DIR" 2>/dev/null; ` +
    `{ printf '{"event":"${event}","p":'; cat; printf '}\\n'; } ` +
    `>> "$NODETERM_HOOK_DIR/$NODETERM_NODE_ID.log" 2>/dev/null || true`
  )
}

function hookEntry(event: string) {
  return [{ hooks: [{ type: 'command', command: hookCommand(event), async: true }] }]
}

function writeSettings(): void {
  const config = {
    hooks: {
      SessionStart: hookEntry('SessionStart'),
      UserPromptSubmit: hookEntry('UserPromptSubmit'),
      Stop: hookEntry('Stop'),
      Notification: hookEntry('Notification'),
      SessionEnd: hookEntry('SessionEnd')
    }
  }
  fs.writeFileSync(settingsPath, JSON.stringify(config, null, 2))
}

/** Write the hooks settings file, clear stale signals, and watch for new hook events. */
export function initClaudeHooks(win: BrowserWindow): void {
  claudeHookPaths()
  try {
    fs.mkdirSync(hookDir, { recursive: true })
    // Start fresh each launch so we don't replay a previous run's events.
    for (const f of fs.readdirSync(hookDir)) {
      if (f.endsWith('.log')) fs.rmSync(path.join(hookDir, f), { force: true })
    }
    writeSettings()
  } catch (e) {
    console.error('[claude-hooks] setup failed', e)
    return
  }

  const offsets = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const scan = () => {
    let files: string[]
    try {
      files = fs.readdirSync(hookDir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.endsWith('.log')) continue
      const full = path.join(hookDir, f)
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
          const obj = JSON.parse(t) as { event?: string; p?: { session_id?: string } }
          if (obj.event && !win.isDestroyed()) {
            win.webContents.send(IPC.claudeStatus, {
              nodeId,
              event: obj.event,
              sessionId: obj.p?.session_id
            })
          }
        } catch {
          // partial/garbled line; ignore
        }
      }
    }
  }

  try {
    fs.watch(hookDir, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(scan, 40)
    })
  } catch (e) {
    console.error('[claude-hooks] watch failed', e)
  }
  // Poll as well: fs.watch on a directory can miss in-file appends on macOS, which would
  // make us see SessionStart but miss the later Stop. Polling a few tiny files is cheap.
  setInterval(scan, 800)
}
