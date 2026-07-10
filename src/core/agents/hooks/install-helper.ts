// The ONE implementation of the per-agent settings.json hook merge. Each agent's thin
// service (claude/codex/gemini) calls these with its own config path, script filename,
// and event list. Behavior (ported from the original claude-hooks.ts):
//   - write the managed script for `agentId` to <userData>/agent-hooks/<scriptFileName>
//     (chmod 0o755, best-effort), then reference it as `sh "<scriptPath>"` from each event;
//   - idempotent re-install: drop any prior managed entry for that event (command includes
//     the `agent-hooks` path segment OR the legacy `claude-signals` marker) before pushing
//     the fresh one;
//   - preserve every other hook (other tools', other events);
//   - fail open: a missing/unparseable settings.json defaults to {} (install) / returns
//     early (remove); a write error is caught + warned, never thrown.
import path from 'path'
import { platform } from '../../platform'
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { buildManagedScript } from './managed-script'

type HookDef = { hooks?: { type: string; command: string }[] }
type Settings = { hooks?: Record<string, HookDef[]>; [k: string]: unknown }

/** Public alias for the hook settings shape, shared by local + remote merge callers. */
export type HookSettings = Settings

function scriptPathFor(scriptFileName: string): string {
  return path.join(platform().userDataDir, 'agent-hooks', scriptFileName)
}

// The marker identifying OUR entry: the `agent-hooks/<scriptFile>` tail of the managed
// command. A bare "agent-hooks" substring is NOT enough — other tools use the same dir
// name (e.g. `~/.someapp/agent-hooks/claude-hook.sh`), and matching them would delete a
// foreign app's hooks from any event we both subscribe to.
function managedMarkerFor(command: string): string {
  const m = command.match(/agent-hooks[\\/][^"'\s]+/)
  return m ? m[0].replace(/\\/g, '/') : 'agent-hooks'
}

/** A managed entry: matches OUR script under `agent-hooks/` or the legacy `claude-signals` marker. */
function isManaged(d: HookDef, marker: string): boolean {
  return !!d.hooks?.some(
    (h) => h.command.includes(marker) || h.command.includes('claude-signals')
  )
}

/** Pure: merge the managed `command` into each event, dropping any prior managed entry. */
export function mergeManagedHook(config: HookSettings, command: string, events: readonly string[]): HookSettings {
  const marker = managedMarkerFor(command)
  const next: HookSettings = { ...config, hooks: { ...(config.hooks ?? {}) } }
  for (const ev of events) {
    const existing = (next.hooks![ev] ?? []).filter((d) => !isManaged(d, marker))
    existing.push({ hooks: [{ type: 'command', command }] })
    next.hooks![ev] = existing
  }
  return next
}

export interface InstallHooksOptions {
  agentId: string
  scriptFileName: string
  configPath: string
  events: readonly string[]
}

export function installHooksInto(opts: InstallHooksOptions): void {
  const { agentId, scriptFileName, configPath, events } = opts

  const sp = scriptPathFor(scriptFileName)
  try {
    mkdirSync(path.dirname(sp), { recursive: true })
    writeFileSync(sp, buildManagedScript(agentId), 'utf8')
  } catch (e) {
    console.warn(`[agent-hooks] ${agentId} script write failed`, e)
    return
  }
  try {
    chmodSync(sp, 0o755)
  } catch {
    /* fail open */
  }

  const command = `sh "${sp}"`
  let config: Settings = {}
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Settings
  } catch {
    config = {}
  }
  config = mergeManagedHook(config, command, events)
  try {
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  } catch (e) {
    console.warn(`[agent-hooks] ${agentId} install failed`, e)
  }
}

export interface RemoveHooksOptions {
  configPath: string
  events: readonly string[]
  /** Our script's file name — narrows the match so foreign agent-hooks entries survive. */
  scriptFileName: string
}

export function removeHooksFrom(opts: RemoveHooksOptions): void {
  const { configPath, events, scriptFileName } = opts
  const marker = `agent-hooks/${scriptFileName}`
  let config: Settings
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as Settings
  } catch {
    return
  }
  if (!config.hooks) return
  for (const ev of events) {
    if (!config.hooks[ev]) continue
    config.hooks[ev] = config.hooks[ev].filter((d) => !d.hooks?.some((h) => h.command.includes(marker)))
    if (config.hooks[ev].length === 0) delete config.hooks[ev]
  }
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')
  } catch {
    /* fail open */
  }
}
