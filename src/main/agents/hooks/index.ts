// Installer registry: drives install/remove of the managed hook script across every
// built-in agent. Each call is wrapped in try/catch with a per-agent console.warn so one
// agent failing never blocks the others (fail open).
import { installClaudeHooks, removeClaudeHooks } from './claude'
import { installCodexHooks, removeCodexHooks } from './codex'
import { installGeminiHooks, removeGeminiHooks } from './gemini'

type HookInstaller = readonly [string, () => void]

export const MANAGED_HOOK_INSTALLERS: readonly HookInstaller[] = [
  ['claude', installClaudeHooks],
  ['codex', installCodexHooks],
  ['gemini', installGeminiHooks]
]

export const MANAGED_HOOK_REMOVERS: readonly HookInstaller[] = [
  ['claude', removeClaudeHooks],
  ['codex', removeCodexHooks],
  ['gemini', removeGeminiHooks]
]

export function installManagedAgentHooks(): void {
  for (const [agent, install] of MANAGED_HOOK_INSTALLERS) {
    try {
      install()
    } catch (e) {
      console.warn(`[agent-hooks] ${agent} install failed`, e)
    }
  }
}

export function removeManagedAgentHooks(): void {
  for (const [agent, remove] of MANAGED_HOOK_REMOVERS) {
    try {
      remove()
    } catch (e) {
      console.warn(`[agent-hooks] ${agent} remove failed`, e)
    }
  }
}
