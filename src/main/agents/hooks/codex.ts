// Codex hook service. Installs the managed script into codex's config under each codex
// hook event. Thin wrapper over the shared install helper.
//
// NOTE: the config path and event names below are PLACEHOLDERS to be confirmed/refined in
// the later codex task (Phase 4). `~/.codex/config.json` is a reasonable convention
// (`~/.codex/` exists on disk); codex's real config is TOML and its hook event names are
// not yet verified — do not rely on these until Phase 4.
import { homedir } from 'os'
import path from 'path'
import { installHooksInto, removeHooksFrom } from './install-helper'

// Confirmed codex event set (verified against REF's agent-hook-listener).
// NOTE: the config path + install mechanism below are still placeholders — they are
// revised in the codex-trust follow-up task. Only this events constant is final here.
const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop'
] as const

const SCRIPT_FILE_NAME = 'codex.sh'

function configPath(): string {
  return path.join(homedir(), '.codex', 'config.json')
}

export function installCodexHooks(): void {
  installHooksInto({
    agentId: 'codex',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: configPath(),
    events: CODEX_EVENTS
  })
}

export function removeCodexHooks(): void {
  removeHooksFrom({
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: configPath(),
    events: CODEX_EVENTS
  })
}
