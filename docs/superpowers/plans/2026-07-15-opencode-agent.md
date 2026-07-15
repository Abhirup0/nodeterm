# opencode Builtin Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opencode (opencode.ai) as a builtin agent with codex/gemini parity: menus + icon, `--prompt` launch, hook-driven status badges via a managed JS plugin, cold-restore resume, context-link, and canvas-control.

**Architecture:** nodeterm's agent system is a declarative registry (`AGENT_CONFIG` + capability membership lists) with per-agent seams: a normalizer for hook events, an installer that plants a managed hook artifact, and instruction-file targets for the context-link/canvas-control CLIs. opencode differs from codex/gemini in two ways: its hook artifact is a **JS plugin file** (not a JSON settings merge) and its transcript is read via **`opencode export <sessionID>`** (storage is SQLite in ≥1.18 — never parse disk).

**Tech Stack:** TypeScript, React, vitest (node env). opencode v1.18.2 is installed locally (`opencode --help` is ground truth).

**Spec:** `docs/superpowers/specs/2026-07-15-opencode-agent-design.md`

## Global Constraints

- All code comments, UI strings, identifiers in **English**.
- `src/core` must never import `electron` or `../main/*` (enforced by `src/core/no-electron.test.ts`).
- claude/codex/gemini launch command strings must stay **byte-identical** — only the new `flag-prompt` branch is added; gemini (declared `stdin-after-start`) keeps today's argv behavior.
- The managed opencode plugin must be **env-gated** (`NODETERM_NODE_ID`/`NODETERM_HOOK_TOKEN`/`NODETERM_HOOK_ENDPOINT` all present, else return `{}`): opencode loads plugins on EVERY CLI command.
- Payload field names from opencode events are NOT a contract — extract defensively; the event NAME is the contract.
- Gates: `npm run typecheck`; `npm test` (known pre-existing flaky failures: `src/core/workspace-watcher.test.ts` fs-watch timing, occasionally `license` setSystemTime — only-those failures are not yours).
- This repo is edited concurrently by other sessions: work happens on an isolated worktree branch; verify unexpected test failures against the base commit before assuming your change caused them.
- Every commit message ends with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_019VnU4dDJZiCmAo7VCABceP`

---

### Task 1: Registry — id, config, capabilities, resume

**Files:**
- Modify: `src/shared/agents/config.ts:5` (union), `:19` (`BUILTIN_AGENT_IDS`), `:21-43` (`AGENT_CONFIG`), `:47-64` (capability lists), `:100-113` (`resumeCommand`)
- Test: `src/shared/agents/config.capabilities.test.ts`, `src/shared/agents/resume.test.ts` (extend both, following each file's existing style)

**Interfaces:**
- Produces: `'opencode'` as a `BuiltinAgentId`; `AGENT_CONFIG.opencode` with `launchCmd: 'opencode'`, `promptInjectionMode: 'flag-prompt'`, `color: '#a78bfa'`, `expectedProcess: 'opencode'`; `hasHooks/canResume/canContextLink/canControlCanvas('opencode') === true`; `resumeCommand('opencode', sid) === \`opencode --session ${sid}\``. Every later task relies on these exact values.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/agents/config.capabilities.test.ts` (adapt imports to the file's existing list):

```ts
describe('opencode capabilities', () => {
  it('is a builtin with the parity capability set', () => {
    expect(BUILTIN_AGENT_IDS).toContain('opencode')
    expect(AGENT_CONFIG.opencode).toEqual({
      label: 'opencode',
      color: '#a78bfa',
      launchCmd: 'opencode',
      promptInjectionMode: 'flag-prompt',
      expectedProcess: 'opencode'
    })
    expect(hasHooks('opencode')).toBe(true)
    expect(canResume('opencode')).toBe(true)
    expect(canContextLink('opencode')).toBe(true)
    expect(canControlCanvas('opencode')).toBe(true)
  })
  it('stays out of the claude-only capability lists', () => {
    for (const can of [canSubagent, canRecur, canBranch, hasUsage, canChat, canTransferFrom, canRename, hasPermissionMode]) {
      expect(can('opencode')).toBe(false)
    }
  })
})
```

Append to `src/shared/agents/resume.test.ts`:

```ts
it('resumes opencode via --session', () => {
  expect(resumeCommand('opencode', 'ses_a1b2c3')).toBe('opencode --session ses_a1b2c3')
})
it('rejects an unsafe opencode session id', () => {
  expect(resumeCommand('opencode', 'x; rm -rf /')).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/agents/config.capabilities.test.ts src/shared/agents/resume.test.ts`
Expected: FAIL — `'opencode'` not in `BUILTIN_AGENT_IDS` / TS error on `AGENT_CONFIG.opencode` (typecheck happens at vitest transform; if the type error blocks the run, that IS the expected RED).

- [ ] **Step 3: Implement the registry entry**

In `src/shared/agents/config.ts`:

```ts
export type BuiltinAgentId = 'claude' | 'codex' | 'gemini' | 'opencode'
```

```ts
export const BUILTIN_AGENT_IDS: readonly BuiltinAgentId[] = ['claude', 'codex', 'gemini', 'opencode']
```

Add to `AGENT_CONFIG` (after `gemini`):

```ts
  opencode: {
    label: 'opencode',
    color: '#a78bfa',
    launchCmd: 'opencode',
    // A bare positional is a PROJECT PATH for opencode, so the initial prompt must go
    // through --prompt (see createAgentNode's flag-prompt branch).
    promptInjectionMode: 'flag-prompt',
    expectedProcess: 'opencode'
  }
```

Capability lists:

```ts
export const AGENT_HOOK_TARGETS = ['claude', 'codex', 'gemini', 'opencode'] as const
export const RESUMABLE_AGENTS = ['claude', 'codex', 'gemini', 'opencode'] as const
export const CONTEXT_LINK_CAPABLE = ['claude', 'codex', 'gemini', 'opencode'] as const
```

Update `CANVAS_CONTROL_CAPABLE` and its comment (opencode reads `~/.config/opencode/AGENTS.md`):

```ts
// Agents allowed to drive the canvas via the `nodeterm` CLI (open/show/write/close).
// Discovery differs per agent: claude gets the manage-nodeterm-canvas skill; codex/gemini/
// opencode a marker block in ~/.codex/AGENTS.md / ~/.gemini/GEMINI.md /
// ~/.config/opencode/AGENTS.md (see canvas-control.ts).
export const CANVAS_CONTROL_CAPABLE = ['claude', 'codex', 'gemini', 'opencode'] as const
```

`resumeCommand` switch — add before `default`:

```ts
    case 'opencode':
      return `opencode --session ${sid}`
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/shared/agents/ && npm run typecheck`
Expected: PASS (all agent tests, including pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add src/shared/agents/config.ts src/shared/agents/config.capabilities.test.ts src/shared/agents/resume.test.ts
git commit -m "feat(agents): register opencode as a builtin (hooks, resume, context-link, canvas-control)"
```

---

### Task 2: Honor `flag-prompt` at launch

**Files:**
- Modify: `src/renderer/state/workspace.ts:296-306` (`createAgentNode`)
- Test: `src/renderer/state/workspace.test.ts` (extend)

**Interfaces:**
- Consumes: `AGENT_CONFIG.opencode.promptInjectionMode === 'flag-prompt'` (Task 1); `agentConfig(id)` and `shellSingleQuote` (both already imported/defined in workspace.ts).
- Produces: `createAgentNode('opencode', 0, undefined, undefined, 'do X')` yields `data.initialCommand === "opencode --prompt 'do X'"`. claude/codex/gemini strings unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/state/workspace.test.ts` (follow the file's existing createAgentNode test style):

```ts
describe('createAgentNode prompt injection', () => {
  it('uses --prompt for flag-prompt agents (opencode)', () => {
    const n = createAgentNode('opencode', 0, undefined, undefined, "rerank the results")
    expect(n.data.initialCommand).toBe("opencode --prompt 'rerank the results'")
  })
  it('shell-quotes a flag-prompt safely', () => {
    const n = createAgentNode('opencode', 0, undefined, undefined, "it's tricky")
    expect(n.data.initialCommand).toBe("opencode --prompt 'it'\\''s tricky'")
  })
  it('keeps argv injection byte-identical for codex and gemini', () => {
    expect(createAgentNode('codex', 0, undefined, undefined, 'do X').data.initialCommand).toBe("codex 'do X'")
    expect(createAgentNode('gemini', 0, undefined, undefined, 'do X').data.initialCommand).toBe("gemini 'do X'")
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/state/workspace.test.ts`
Expected: FAIL — opencode command is `opencode 'rerank the results'` (positional, the bug this task fixes).

- [ ] **Step 3: Implement the flag-prompt branch**

In `createAgentNode` (workspace.ts:296-306), replace the `withPrompt` computation:

```ts
  const { label, color, launchCmd } = resolveAgent(agentId)
  const baseCmd = agentId === 'claude' ? claudeLaunchCommand() : launchCmd
  // A flag-prompt agent (opencode) takes the initial prompt via its flag — a bare positional
  // would be misread (opencode treats it as a project path). Everything else keeps the
  // historical argv append, INCLUDING stdin-after-start agents (gemini has always launched
  // via argv here; changing that is a separate decision).
  const promptArg = initialPrompt
    ? shellSingleQuote(initialPrompt.replace(/\s+/g, ' ').trim())
    : null
  const withPrompt = promptArg
    ? agentConfig(agentId)?.promptInjectionMode === 'flag-prompt'
      ? `${baseCmd} --prompt ${promptArg}`
      : `${baseCmd} ${promptArg}`
    : baseCmd
```

(`agentConfig` may already be imported in workspace.ts via `resolveAgent`'s import — check the import list; add `agentConfig` to the `@shared/agents/config` import if missing.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/renderer/state/ && npm run typecheck`
Expected: PASS, including every pre-existing workspace test (the argv regression net).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/workspace.ts src/renderer/state/workspace.test.ts
git commit -m "feat(agents): honor flag-prompt injection at launch (opencode --prompt)"
```

---

### Task 3: `normalizeOpencode` — hook events → shared state model

**Files:**
- Modify: `src/shared/agents/normalize.ts` (new payload interface + normalizer after `normalizeGemini` at `:228-244`; dispatch in `normalizeFor` at `:246-251`)
- Test: `src/shared/agents/normalize.test.ts` (extend)

**Interfaces:**
- Consumes: `RawHookEnvelope` / `NormalizedAgentEvent` (defined in the same file).
- Produces: `normalizeOpencode(env: RawHookEnvelope): NormalizedAgentEvent | null`; `normalizeFor('opencode', env)` routes to it. The plugin (Task 4) POSTs payloads shaped `{ event: string, sessionID?: string, role?: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `src/shared/agents/normalize.test.ts` (follow the file's existing envelope-builder style):

```ts
describe('normalizeOpencode', () => {
  const env = (payload: Record<string, unknown>) => ({ nodeId: 'n1', agentId: 'opencode' as const, payload })

  it('maps session.created to a session start with the id', () => {
    expect(normalizeFor('opencode', env({ event: 'session.created', sessionID: 'ses_1' }))).toEqual({
      nodeId: 'n1', agentId: 'opencode', sessionId: 'ses_1', kind: 'session', sessionPhase: 'start'
    })
  })
  it('maps a user message.updated to working + newTurn', () => {
    expect(normalizeFor('opencode', env({ event: 'message.updated', role: 'user', sessionID: 'ses_1' }))).toMatchObject({
      kind: 'state', state: 'working', newTurn: true
    })
  })
  it('maps tool.execute.before to working (no newTurn)', () => {
    const e = normalizeFor('opencode', env({ event: 'tool.execute.before' }))
    expect(e).toMatchObject({ kind: 'state', state: 'working' })
    expect(e?.newTurn).toBeUndefined()
  })
  it('maps permission.asked to blocked and permission.replied back to working', () => {
    expect(normalizeFor('opencode', env({ event: 'permission.asked' }))).toMatchObject({ state: 'blocked' })
    expect(normalizeFor('opencode', env({ event: 'permission.replied' }))).toMatchObject({ state: 'working' })
  })
  it('maps session.idle and session.error to done', () => {
    expect(normalizeFor('opencode', env({ event: 'session.idle' }))).toMatchObject({ state: 'done' })
    expect(normalizeFor('opencode', env({ event: 'session.error' }))).toMatchObject({ state: 'done' })
  })
  it('ignores unknown events', () => {
    expect(normalizeFor('opencode', env({ event: 'tui.toast.show' }))).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/shared/agents/normalize.test.ts`
Expected: FAIL — `normalizeFor` returns `null` for opencode.

- [ ] **Step 3: Implement the normalizer**

Add after `normalizeGemini` in `normalize.ts`:

```ts
// opencode plugin payload (see core/agents/hooks/opencode.ts). The managed plugin forwards
// { event, sessionID?, role? } per hook; field names beyond `event` are read defensively —
// opencode's event payload shapes are not a contract, so the event NAME carries the mapping.
interface OpencodePayload {
  event?: string
  sessionID?: string
  session_id?: string
  role?: string
}

export function normalizeOpencode(env: RawHookEnvelope): NormalizedAgentEvent | null {
  const p = env.payload as OpencodePayload
  const base = { nodeId: env.nodeId, agentId: env.agentId, sessionId: p.sessionID ?? p.session_id }

  if (p.event === 'session.created') return { ...base, kind: 'session', sessionPhase: 'start' }
  // The plugin forwards message.updated only for user messages — opencode's turn start
  // (mirrors Claude's UserPromptSubmit), so per-turn fan-out clears once per turn.
  if (p.event === 'message.updated' && p.role === 'user') {
    return { ...base, kind: 'state', state: 'working', newTurn: true }
  }
  if (p.event === 'tool.execute.before') return { ...base, kind: 'state', state: 'working' }
  if (p.event === 'permission.asked') return { ...base, kind: 'state', state: 'blocked' }
  if (p.event === 'permission.replied') return { ...base, kind: 'state', state: 'working' }
  if (p.event === 'session.idle' || p.event === 'session.error') {
    return { ...base, kind: 'state', state: 'done' }
  }
  return null
}
```

Dispatch in `normalizeFor`:

```ts
  if (agentId === 'opencode') return normalizeOpencode(env)
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/shared/agents/normalize.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/agents/normalize.ts src/shared/agents/normalize.test.ts
git commit -m "feat(agents): normalize opencode plugin events to the shared state model"
```

---

### Task 4: Managed opencode plugin installer

**Files:**
- Create: `src/core/agents/hooks/opencode.ts`
- Modify: `src/core/agents/hooks/index.ts:10-20` (installer/remover registries)
- Test: `src/core/agents/hooks/opencode.test.ts` (new)

**Interfaces:**
- Consumes: nothing from other tasks (the hook server already routes `/hook/opencode` → `normalizeFor('opencode', …)` generically).
- Produces: `installOpencodeHooks(): void`, `removeOpencodeHooks(): void`, and exported-for-test `buildOpencodePlugin(): string`, `pluginPath(): string`, `PLUGIN_MARKER`.

- [ ] **Step 1: Write the failing tests**

Create `src/core/agents/hooks/opencode.test.ts`:

```ts
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_MARKER, buildOpencodePlugin, installOpencodeHooks, removeOpencodeHooks } from './opencode'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmp)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const planted = () => path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js')

describe('opencode plugin install', () => {
  it('writes the marker-bearing plugin file (idempotent)', () => {
    installOpencodeHooks()
    installOpencodeHooks()
    const body = fs.readFileSync(planted(), 'utf8')
    expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
    expect(body).toContain('NODETERM_NODE_ID')
    expect(body).toContain('/hook/opencode')
  })
  it('never overwrites a user file without the marker', () => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
  })
  it('remove deletes only a marker-bearing file', () => {
    installOpencodeHooks()
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
  })
  it('generated plugin is env-gated and fail-open', () => {
    const body = buildOpencodePlugin()
    expect(body).toContain('return {}') // missing env → no-op
    expect(body).toContain('catch') // POSTs never throw into opencode
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/core/agents/hooks/opencode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the installer**

Create `src/core/agents/hooks/opencode.ts`:

```ts
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

export function pluginPath(): string {
  return path.join(os.homedir(), '.config', 'opencode', 'plugins', 'nodeterm-status.js')
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
```

Register in `src/core/agents/hooks/index.ts`:

```ts
import { installOpencodeHooks, removeOpencodeHooks } from './opencode'
```

```ts
export const MANAGED_HOOK_INSTALLERS: readonly HookInstaller[] = [
  ['claude', installClaudeHooks],
  ['codex', installCodexHooks],
  ['gemini', installGeminiHooks],
  ['opencode', installOpencodeHooks]
]

export const MANAGED_HOOK_REMOVERS: readonly HookInstaller[] = [
  ['claude', removeClaudeHooks],
  ['codex', removeCodexHooks],
  ['gemini', removeGeminiHooks],
  ['opencode', removeOpencodeHooks]
]
```

- [ ] **Step 4: Run tests + typecheck + no-electron gate**

Run: `npx vitest run src/core/agents/hooks/ src/core/no-electron.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/agents/hooks/opencode.ts src/core/agents/hooks/opencode.test.ts src/core/agents/hooks/index.ts
git commit -m "feat(hooks): managed opencode plugin (env-gated, marker-owned, fail-open)"
```

---

### Task 5: Instruction-file targets (context-link + canvas-control)

**Files:**
- Modify: `src/main/context-link.ts:103-108` (`installAgentInstructions` targets)
- Modify: `src/main/canvas-control.ts:148-153` (`installAgentInstructions` targets) and the `--agent claude|codex|gemini|<custom-id>` prose in `canvas-control.ts` (skill body, ~line 66) and `src/main/canvas-control-core.ts` (`buildCanvasControlInstructions` verbs list)

**Interfaces:**
- Consumes: nothing new — the merge helpers are marker-generic.
- Produces: both CLIs' discovery blocks land in `~/.config/opencode/AGENTS.md` (opencode reads global AGENTS.md).

- [ ] **Step 1: Add the target path in both installers**

In `src/main/context-link.ts` `installAgentInstructions`:

```ts
  const targets = [
    path.join(os.homedir(), '.codex', 'AGENTS.md'),
    path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md')
  ]
```

In `src/main/canvas-control.ts` `installAgentInstructions`:

```ts
  const targets = [
    path.join(os.homedir(), '.codex', 'AGENTS.md'),
    path.join(os.homedir(), '.gemini', 'GEMINI.md'),
    path.join(os.homedir(), '.config', 'opencode', 'AGENTS.md')
  ]
```

Also update the comment above each function that names the codex/gemini files, adding opencode's.

- [ ] **Step 2: Update the `open-agent` prose examples**

In `src/main/canvas-control.ts` (skill body) and `src/main/canvas-control-core.ts` (`buildCanvasControlInstructions`), replace both occurrences of
`open-agent --agent claude|codex|gemini|<custom-id>` with
`open-agent --agent claude|codex|gemini|opencode|<custom-id>` (functional behavior is unchanged — `open-agent` accepts any id — this is discoverability prose).

- [ ] **Step 3: Gate**

Run: `npm run typecheck && npx vitest run src/main/canvas-control-core.test.ts src/core/context-link-core.test.ts`
Expected: PASS (marker/merge tests are prose-agnostic).

- [ ] **Step 4: Commit**

```bash
git add src/main/context-link.ts src/main/canvas-control.ts src/main/canvas-control-core.ts
git commit -m "feat(agents): opencode AGENTS.md gets the context-link + canvas-control blocks"
```

---

### Task 6: Context-link CLI — opencode transcript via `opencode export`

**Files:**
- Modify: `src/core/context-link-core.ts` — inside the `CLI_SCRIPT` template literal: add `linesFromOpencodeExport` next to `linesFromCodex`/`linesFromGeminiFile` (~line 196-240) and branch `readTranscript` (~line 267-277)
- Test: `src/core/context-link-core.test.ts` or the CLI test file `src/core/context-link.cli.test.ts` (follow where existing per-agent parser tests live; add the opencode fixture test beside them)

**Interfaces:**
- Consumes: link-file node entries already carry `agent` and `sessionId` (per-entry). `execFileSync` is already imported inside the CLI script.
- Produces: `readTranscript(node)` returns formatted lines for `node.agent === 'opencode'` by spawning `opencode export <sessionId>`.

**IMPORTANT — template-literal escaping:** `CLI_SCRIPT` is a JS template literal; the existing parsers write `\n` as `\\n` and avoid backticks entirely (ES5-style `var`/`function`). Match that style exactly or the generated script breaks.

- [ ] **Step 1: Write the failing test**

The export JSON shape is defensive, not a version contract. Add to the test file that exercises the generated CLI's parsers (find where `linesFromCodex` behavior is tested — if parsers are only tested through the generated script, follow that harness):

```ts
describe('opencode export transcript', () => {
  it('formats messages from an export payload', () => {
    // Fixture mirrors the defensive shape linesFromOpencodeExport accepts:
    // top-level messages array, each with role/parts-or-content.
    const fixture = JSON.stringify({
      messages: [
        { role: 'user', parts: [{ type: 'text', text: 'add rerank' }] },
        { role: 'assistant', parts: [{ type: 'text', text: 'done, added rerank.ts' }, { type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } } }] }
      ]
    })
    const lines = runCliParser('opencode', fixture) // use the file's existing harness for invoking the generated parser
    expect(lines.join('\n')).toContain('user: add rerank')
    expect(lines.join('\n')).toContain('assistant: done, added rerank.ts')
  })
})
```

If no such harness exists (parsers untested today), test instead at the string level: assert `CLI_SCRIPT` contains `linesFromOpencodeExport` and the `opencode` branch in `readTranscript`, plus `execFileSync('opencode', ['export',` — and note in the report that parser logic is exercised via the live CLI only.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/core/context-link-core.test.ts src/core/context-link.cli.test.ts`
Expected: FAIL on the new case.

- [ ] **Step 3: Implement inside `CLI_SCRIPT`**

Add next to the other parsers (ES5 style, `\\n` escaping — this code lives INSIDE the template literal):

```js
// opencode >=1.18 stores sessions in SQLite — never parse its disk. The CLI exports a
// session as JSON: `opencode export <sessionID>`. Shape read defensively: a messages array
// whose items carry role + parts[] (text / tool) or a plain content string.
function linesFromOpencodeExport(node) {
  if (!node.sessionId) { out('"' + node.title + '" has no session id yet.'); return [] }
  var raw
  try {
    raw = execFileSync('opencode', ['export', String(node.sessionId)], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) { out('Could not export "' + node.title + '" session (is opencode installed?).'); return [] }
  var o
  try { o = JSON.parse(raw) } catch (e) { out('Unreadable opencode export for "' + node.title + '".'); return [] }
  var msgs = Array.isArray(o) ? o : (o && (o.messages || (o.data && o.data.messages))) || []
  var res = []
  msgs.forEach(function (m) {
    if (!m) return
    var role = (m.role || (m.info && m.info.role)) === 'user' ? 'user' : 'assistant'
    var parts = m.parts || (Array.isArray(m.content) ? m.content : null)
    if (typeof m.content === 'string' && m.content) { res.push(role + ': ' + m.content); return }
    if (!Array.isArray(parts)) return
    parts.forEach(function (c) {
      if (!c) return
      if (typeof c.text === 'string' && c.text && (c.type === 'text' || !c.type)) res.push(role + ': ' + c.text)
      else if (c.type === 'tool' || c.type === 'tool_use' || c.tool) {
        var name = c.tool || c.name || 'tool'
        var input = c.state && c.state.input ? c.state.input : c.input
        var a = input && (input.command || input.filePath || input.file_path || input.pattern || input.description)
        res.push('  $ ' + name + (typeof a === 'string' ? ' ' + a.slice(0, 200) : ''))
      }
    })
  })
  if (!res.length) out('"' + node.title + '" export contained no readable messages.')
  return res
}
```

Branch `readTranscript` FIRST (before path resolution — opencode has no transcript file):

```js
function readTranscript(node) {
  if (node.agent === 'opencode') return linesFromOpencodeExport(node)
  var p = resolveTranscript(node)
  ...unchanged...
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/core/ && npm run typecheck`
Expected: PASS (workspace-watcher flake excepted).

- [ ] **Step 5: Commit**

```bash
git add src/core/context-link-core.ts src/core/context-link-core.test.ts src/core/context-link.cli.test.ts
git commit -m "feat(context-link): read opencode transcripts via 'opencode export' (SQLite-safe)"
```

(Stage whichever of the two test files you actually touched.)

---

### Task 7: Icon

**Files:**
- Create: `src/renderer/assets/opencode.svg`
- Modify: `src/renderer/lib/agentIcons.tsx:1-12` (import + `AGENT_LOGO` entry)

**Interfaces:**
- Consumes: the existing `AGENT_LOGO` map + Vite SVG asset imports (same as `codex-color.svg`).
- Produces: `AgentIcon({ agentId: 'opencode' })` renders the mark instead of the terminal fallback.

- [ ] **Step 1: Add the asset**

Create `src/renderer/assets/opencode.svg` — an original terminal-bracket mark in the agent color (NOT a copied trademark file):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#a78bfa" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M8 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h3" />
  <path d="M16 4h3a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-3" />
  <circle cx="12" cy="12" r="2.2" fill="#a78bfa" stroke="none" />
</svg>
```

- [ ] **Step 2: Register it**

In `src/renderer/lib/agentIcons.tsx`:

```ts
import opencodeIcon from '../assets/opencode.svg'
```

```ts
const AGENT_LOGO: Partial<Record<string, string>> = {
  claude: claudeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
  opencode: opencodeIcon
}
```

- [ ] **Step 3: Gate + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/renderer/assets/opencode.svg src/renderer/lib/agentIcons.tsx
git commit -m "feat(agents): opencode menu icon"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck && npm test` — green (known flakes excepted).
- [ ] `opencode` appears in the dock/pane/palette agent menus (derived from `BUILTIN_AGENT_IDS` — no extra wiring should have been needed).
- [ ] Live E2E (needs a provider key — post-merge manual, noted for the user): spawn an opencode node with a prompt → `--prompt` lands; run a turn → RUNNING/done badge flips; `opencode export` transcript readable through a context link.
