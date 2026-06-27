// Codex hook service. Codex gates every hook behind a TRUST entry in
// ~/.codex/config.toml: a hook command in ~/.codex/hooks.json will NOT fire
// unless config.toml has a matching [hooks.state."<key>"] block whose
// `trusted_hash` equals Codex's hash of that hook definition. Without it the
// hook silently never runs. We reproduce Codex's hash via the ported trust
// core (codex-trust.ts) so a Codex node's status badge lights up without the
// user having to /hooks-approve.
//
// Unlike claude/gemini (which only merge JSON settings via install-helper),
// codex needs the extra config.toml trust write, so this service does its own
// hooks.json merge instead of using install-helper. It writes into the user's
// REAL ~/.codex (default CODEX_HOME) — no managed home, no auth/config mirror.
//
// Adapted for the REAL ~/.codex (local install path only):
// dropped the managed CODEX_HOME, system-hook mirroring, project-trust, legacy
// cleanup, and Windows/remote paths. POSIX (macOS) is the target.
import { homedir } from 'os'
import path from 'path'
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  unlinkSync
} from 'fs'
import { randomUUID } from 'crypto'
import { app } from 'electron'
import { buildManagedScript } from './managed-script'
import {
  computeTrustedHash,
  getCodexCanonicalTrustPath,
  parseTrustKey,
  readHookTrustEntries,
  removeHookTrustEntries,
  upsertHookTrustEntries,
  type CodexEventLabel,
  type CodexTrustEntry
} from './codex-trust'

// Confirmed codex event set.
const CODEX_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'Stop'
] as const

// Why: Codex's trust hash key uses the snake_case event label (see
// codex-rs/hooks/src/lib.rs::hook_event_key_label), while hooks.json uses the
// PascalCase serde-rename. Map between them in one place so the trust-write
// path can't drift from the hooks.json install path.
const CODEX_EVENT_LABEL: Record<(typeof CODEX_EVENTS)[number], CodexEventLabel> = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_prompt_submit',
  PreToolUse: 'pre_tool_use',
  PermissionRequest: 'permission_request',
  PostToolUse: 'post_tool_use',
  Stop: 'stop'
}

const SCRIPT_FILE_NAME = 'codex.sh'

// hooks.json shape Codex expects: { hooks: { <EventName>: HookDefinition[] } }
// where each HookDefinition has a `hooks` array of command handlers.
type HookCommandConfig = { type: 'command'; command: string; [k: string]: unknown }
type HookDefinition = { hooks?: HookCommandConfig[]; [k: string]: unknown }
type HooksConfig = { hooks?: Record<string, HookDefinition[]>; [k: string]: unknown }

function codexHome(): string {
  // Default CODEX_HOME. We intentionally write into the user's REAL ~/.codex.
  return path.join(homedir(), '.codex')
}

function hooksJsonPath(): string {
  return path.join(codexHome(), 'hooks.json')
}

function configTomlPath(): string {
  return path.join(codexHome(), 'config.toml')
}

function scriptPath(): string {
  return path.join(app.getPath('userData'), 'agent-hooks', SCRIPT_FILE_NAME)
}

// Why: match managed entries by the `agent-hooks/codex.sh` path segment (not
// the exact command string) so a fresh install also sweeps stale entries from
// an older build or a different userData path. The managed-command matcher
// keys off the path segment, not the exact command string.
function isManagedCommand(command: string | undefined): boolean {
  if (!command) return false
  return command.replaceAll('\\', '/').includes(`agent-hooks/${SCRIPT_FILE_NAME}`)
}

function definitionHasManagedCommand(def: HookDefinition): boolean {
  return Array.isArray(def.hooks) && def.hooks.some((h) => isManagedCommand(h.command))
}

// Why: strip our managed handler out of a definition's `hooks` array, dropping
// the whole definition if nothing user-authored remains. Preserves all other
// handlers/definitions byte-for-byte.
function removeManagedFromDefinitions(defs: HookDefinition[]): HookDefinition[] {
  return defs.flatMap((def) => {
    if (!definitionHasManagedCommand(def)) {
      return [def]
    }
    const filtered = (def.hooks ?? []).filter((h) => !isManagedCommand(h.command))
    if (filtered.length === 0) {
      return []
    }
    return [{ ...def, hooks: filtered }]
  })
}

// Why: form the POSIX command the SAME way for hooks.json AND the trust entry —
// the trust hash is computed over this exact byte string, so any divergence
// makes Codex reject the hook. The POSIX wrapper's
// `[ -x ... ]` guard makes a missing/non-executable script a silent no-op so a
// broken install never poisons the session with exit-127 noise.
function buildManagedCommand(script: string): string {
  // POSIX single-quote escape so $, `, ", \ in the path are taken literally.
  const quoted = `'${script.replaceAll("'", "'\\''")}'`
  return `if [ -x ${quoted} ]; then /bin/sh ${quoted}; fi`
}

function readHooksJson(file: string): HooksConfig | null {
  if (!existsSync(file)) {
    return {}
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as HooksConfig)
      : null
  } catch {
    return null
  }
}

// Why: temp+rename so a crash mid-write leaves the original hooks.json intact.
function writeHooksJson(file: string, config: HooksConfig): void {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
    renamed = true
  } finally {
    if (!renamed && existsSync(tmp)) {
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
    }
  }
}

function writeManagedScript(file: string): void {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const content = buildManagedScript('codex')
  const tmp = path.join(dir, `.${Date.now()}-${randomUUID()}.tmp`)
  let renamed = false
  try {
    writeFileSync(tmp, content, 'utf8')
    try {
      // chmod before rename so the canonical path is never visible
      // non-executable (the `[ -x ]` guard would skip the hook in that window).
      chmodSync(tmp, 0o755)
    } catch {
      /* fail open */
    }
    renameSync(tmp, file)
    renamed = true
  } finally {
    if (!renamed && existsSync(tmp)) {
      try {
        unlinkSync(tmp)
      } catch {
        /* best effort */
      }
    }
  }
}

export function installCodexHooks(): void {
  const script = scriptPath()
  try {
    writeManagedScript(script)
  } catch (e) {
    console.warn('[agent-hooks] codex script write failed', e)
    return
  }

  const command = buildManagedCommand(script)
  const hooksFile = hooksJsonPath()
  const config = readHooksJson(hooksFile)
  if (!config) {
    console.warn('[agent-hooks] codex install: could not parse hooks.json; skipping')
    return
  }

  try {
    const nextHooks: Record<string, HookDefinition[]> = { ...(config.hooks ?? {}) }
    const managedEvents = new Set<string>(CODEX_EVENTS)

    // Why: sweep managed entries out of events we no longer subscribe to (e.g.
    // left over from an older install) so we don't keep firing stale hooks.
    for (const [eventName, defs] of Object.entries(nextHooks)) {
      if (managedEvents.has(eventName) || !Array.isArray(defs)) {
        continue
      }
      const cleaned = removeManagedFromDefinitions(defs)
      if (cleaned.length === 0) {
        delete nextHooks[eventName]
      } else {
        nextHooks[eventName] = cleaned
      }
    }

    // Why: prepend our managed handler to each subscribed event (idempotent —
    // strip any prior managed copy first) and record the matching trust entry
    // at groupIndex 0 / handlerIndex 0. Prepending keeps the status hook ahead
    // of any user hooks so a slow user hook can't leave the badge stale.
    const trustEntries: CodexTrustEntry[] = []
    for (const eventName of CODEX_EVENTS) {
      const current = Array.isArray(nextHooks[eventName]) ? nextHooks[eventName] : []
      const cleaned = removeManagedFromDefinitions(current)
      const definition: HookDefinition = { hooks: [{ type: 'command', command }] }
      nextHooks[eventName] = [definition, ...cleaned]
      trustEntries.push({
        sourcePath: hooksFile,
        eventLabel: CODEX_EVENT_LABEL[eventName],
        groupIndex: 0,
        handlerIndex: 0,
        command
      })
    }

    config.hooks = nextHooks
    writeHooksJson(hooksFile, config)

    // Why: write trust LAST so a half-write can't leave a hash pointing at a
    // hook that doesn't exist. upsert does a line-level merge that preserves
    // all other config.toml content.
    upsertHookTrustEntries(configTomlPath(), trustEntries)
  } catch (e) {
    console.warn('[agent-hooks] codex install failed', e)
  }
}

export function removeCodexHooks(): void {
  const hooksFile = hooksJsonPath()
  const command = buildManagedCommand(scriptPath())

  try {
    const config = readHooksJson(hooksFile)
    if (config && existsSync(hooksFile)) {
      const nextHooks: Record<string, HookDefinition[]> = { ...(config.hooks ?? {}) }
      let removed = false
      for (const [eventName, defs] of Object.entries(nextHooks)) {
        if (!Array.isArray(defs)) {
          continue
        }
        const cleaned = removeManagedFromDefinitions(defs)
        if (JSON.stringify(cleaned) !== JSON.stringify(defs)) {
          removed = true
        }
        if (cleaned.length === 0) {
          delete nextHooks[eventName]
        } else {
          nextHooks[eventName] = cleaned
        }
      }
      if (removed) {
        config.hooks = nextHooks
        writeHooksJson(hooksFile, config)
      }
    }
  } catch (e) {
    console.warn('[agent-hooks] codex hooks.json remove failed', e)
  }

  // Why: also drop OUR trust entries so config.toml doesn't accumulate dead
  // [hooks.state."..."] blocks. Match by hash equivalence to our managed
  // command — a sourcePath-only filter would wipe the user's manually-approved
  // entries that happen to share the path. Best-effort.
  try {
    const tomlPath = configTomlPath()
    const existing = readHookTrustEntries(tomlPath)
    const canonicalSource = getCodexCanonicalTrustPath(hooksFile)
    const managedEventLabels = new Set<CodexEventLabel>(
      CODEX_EVENTS.map((e) => CODEX_EVENT_LABEL[e])
    )
    const ourKeys: string[] = []
    for (const [key, state] of existing) {
      const parts = parseTrustKey(key)
      if (!parts) continue
      if (getCodexCanonicalTrustPath(parts.sourcePath) !== canonicalSource) continue
      if (!managedEventLabels.has(parts.eventLabel)) continue
      const expectedHash = computeTrustedHash({
        sourcePath: hooksFile,
        eventLabel: parts.eventLabel,
        groupIndex: parts.groupIndex,
        handlerIndex: parts.handlerIndex,
        command
      })
      if (state.trustedHash !== expectedHash) continue
      ourKeys.push(key)
    }
    if (ourKeys.length > 0) {
      removeHookTrustEntries(tomlPath, ourKeys)
    }
  } catch (e) {
    console.warn('[agent-hooks] codex trust remove failed', e)
  }
}
