// Claude hook service. Installs the managed script into ~/.claude/settings.json under
// each Claude Code hook event. Thin wrapper over the shared install helper.
import { homedir } from 'os'
import path from 'path'
import { installHooksInto, removeHooksFrom } from './install-helper'

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

export function removeClaudeHooks(): void {
  removeHooksFrom({
    configPath: configPath(),
    events: CLAUDE_EVENTS,
    scriptFileName: SCRIPT_FILE_NAME
  })
}
