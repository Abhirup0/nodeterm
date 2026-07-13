// Claude hook service. Installs the managed script into ~/.claude/settings.json under
// each Claude Code hook event. Thin wrapper over the shared install helper.
import { homedir } from 'os'
import path from 'path'
import { installHooksInto, removeHooksFrom } from './install-helper'
import { ensureFullscreenTuiInFile } from './claude-tui'
import { claudeCliCaps } from '../../claude-cli'

const CLAUDE_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  // Fires INSTEAD of Stop when the turn ends on an API/model error — without it the
  // status badge sticks on "working" after any errored turn.
  'StopFailure',
  'Notification',
  // Dedicated permission-prompt signal (→ blocked), more direct than Notification.
  'PermissionRequest',
  'SessionEnd',
  'PreToolUse',
  'PostToolUse'
] as const

const SCRIPT_FILE_NAME = 'claude.sh'

function configPath(): string {
  return path.join(homedir(), '.claude', 'settings.json')
}

export function installClaudeHooks(): void {
  installHooksInto({
    agentId: 'claude',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: configPath(),
    events: CLAUDE_EVENTS
  })
}

/** Install the managed hook into a specific Claude config dir (managed accounts). */
export function installClaudeHooksInto(configDir: string): void {
  installHooksInto({
    agentId: 'claude',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: path.join(configDir, 'settings.json'),
    events: CLAUDE_EVENTS
  })
}

/**
 * Ensure `"tui": "fullscreen"` in the SYSTEM `~/.claude/settings.json` — write-if-absent, and only
 * when the local CLI is >= 2.1.89 (see FULLSCREEN_TUI_MIN_VERSION / claudeCliCaps.fullscreenTui).
 * Best-effort: the probe is memoized + never rejects, the write fails open. Call it AFTER the hook
 * install so the merge lands on a settings.json that already has the managed hooks.
 */
export async function ensureClaudeFullscreenTui(): Promise<void> {
  if (!(await claudeCliCaps()).fullscreenTui) return
  ensureFullscreenTuiInFile(configPath())
}

/** Same guardrails, for a managed account's config dir (`<dir>/settings.json`). */
export async function ensureClaudeFullscreenTuiInto(configDir: string): Promise<void> {
  if (!(await claudeCliCaps()).fullscreenTui) return
  ensureFullscreenTuiInFile(path.join(configDir, 'settings.json'))
}

export function removeClaudeHooks(): void {
  removeHooksFrom({
    configPath: configPath(),
    events: CLAUDE_EVENTS,
    scriptFileName: SCRIPT_FILE_NAME
  })
}
