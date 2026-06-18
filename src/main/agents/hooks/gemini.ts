// Gemini hook service. Installs the managed script into ~/.gemini/settings.json under
// each Gemini hook event. Thin wrapper over the shared install helper.
import { homedir } from 'os'
import path from 'path'
import { installHooksInto, removeHooksFrom } from './install-helper'

const GEMINI_EVENTS = ['BeforeAgent', 'AfterAgent', 'AfterTool', 'BeforeTool'] as const

const SCRIPT_FILE_NAME = 'gemini.sh'

function configPath(): string {
  return path.join(homedir(), '.gemini', 'settings.json')
}

export function installGeminiHooks(): void {
  installHooksInto({
    agentId: 'gemini',
    scriptFileName: SCRIPT_FILE_NAME,
    configPath: configPath(),
    events: GEMINI_EVENTS
  })
}

export function removeGeminiHooks(): void {
  removeHooksFrom({
    configPath: configPath(),
    events: GEMINI_EVENTS
  })
}
