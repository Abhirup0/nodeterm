# opencode builtin agent — design

**Date:** 2026-07-15
**Status:** approved (design reviewed in-session)
**Scope decision:** codex/gemini parity — registry + icon + flag-prompt + hooks (JS plugin) +
resume + context-link + canvas-control. Explicitly OUT of v1: handoff/transfer source, usage,
subagent viz, chat, branch, rename, recurring, permission-mode flag mapping (opencode's
equivalent is `--auto`), multi-account (`OPENCODE_DATA_DIR` exists but unwired), and remote-SSH
hook install (deferred exactly like codex's).

## Verified ground truth (live install, opencode v1.18.2)

- Binary `opencode`; TUI starts with `opencode [project]`; **initial prompt is the `--prompt`
  flag** (a bare positional is a project path, NOT a prompt).
- Resume: `--continue`/`-c`, `--session <id>`/`-s`, `--fork`; permission auto-approve: `--auto`.
- Plugins: BOTH `~/.config/opencode/plugin/` and `~/.config/opencode/plugins/` load (verified);
  use the documented `plugins/`. Plugins load for every CLI command (even `session list`), so
  the managed plugin MUST be env-gated to be a no-op outside nodeterm sessions.
- Plugin API: `export const Name = async ({ project, client, $, directory, worktree }) => ({
  "event.name": async (input, output) => {...} })`. Relevant events: `session.created`,
  `session.idle`, `session.error`, `permission.asked`, `permission.replied`,
  `tool.execute.before`, `message.updated`. Runtime is Bun — global `fetch` available.
- Storage in ≥1.18 is **SQLite** (`~/.local/share/opencode/opencode.db`) — the community-doc
  JSON-file layout is obsolete. Transcript access goes through **`opencode export <sessionID>`**
  (JSON to stdout), never disk parsing.
- Reads global `~/.config/opencode/AGENTS.md` (plus project AGENTS.md / CLAUDE.md fallback).
- Config dir `~/.config/opencode/` (`opencode.jsonc`, `plugins/`, `package.json`).

## 1. Registry (`src/shared/agents/config.ts`)

- `BuiltinAgentId` union + `BUILTIN_AGENT_IDS` gain `'opencode'` (after `gemini`).
- `AGENT_CONFIG.opencode = { label: 'opencode', color: '#a78bfa', launchCmd: 'opencode',
  promptInjectionMode: 'flag-prompt', expectedProcess: 'opencode' }`.
- Capability lists: add `'opencode'` to `AGENT_HOOK_TARGETS`, `RESUMABLE_AGENTS`,
  `CONTEXT_LINK_CAPABLE`, `CANVAS_CONTROL_CAPABLE`. All other lists unchanged.
- `resumeCommand`: `case 'opencode': return \`opencode --session ${sid}\`` (sid already
  SAFE_SESSION_ID-validated).
- All menus (dock, pane, palette, Settings→Agents) derive from `BUILTIN_AGENT_IDS` — no UI
  edits needed beyond the icon.

## 2. flag-prompt honored at launch (`src/renderer/state/workspace.ts`)

`createAgentNode` currently appends the prompt as a positional argv for every agent. New rule:
when the builtin's `promptInjectionMode === 'flag-prompt'`, emit
`${baseCmd} --prompt ${shellSingleQuote(prompt)}` instead. **`argv` and `stdin-after-start`
agents keep today's argv behavior bit-for-bit** (gemini is declared `stdin-after-start` but has
always launched via argv-append; changing that is out of scope — only the new mode branch is
added). Regression-tested: claude/codex/gemini command strings unchanged.

## 3. Hooks: managed JS plugin + normalizer

- **Installer** `src/core/agents/hooks/opencode.ts` (registered in `MANAGED_HOOK_INSTALLERS` /
  `MANAGED_HOOK_REMOVERS` in `hooks/index.ts`): writes
  `~/.config/opencode/plugins/nodeterm-status.js`, overwriting only a file that carries the
  nodeterm marker comment (first line `// nodeterm managed plugin — do not edit`); remove
  deletes only a marker-bearing file. No JSON merging — the plugin is a whole owned file.
- **Plugin body** (generated string, plain JS, no deps): mirrors the managed POSIX script's
  wire contract — gates on `process.env.NODETERM_NODE_ID` (missing → return `{}`; no-op in the
  user's normal opencode sessions — plugins load on every command, so this gate is mandatory),
  and per POST re-reads the `NODETERM_HOOK_ENDPOINT` FILE (KEY=VALUE lines) for the live
  port/token (restart handoff; falls back to `NODETERM_HOOK_PORT`/`NODETERM_HOOK_TOKEN` env).
  Wire format: urlencoded `nodeId` + `version` + `payload` (JSON) with the
  `x-nodeterm-hook-token` header to `http://127.0.0.1:<port>/hook/opencode`.
  Otherwise returns handlers for: `session.created`, `session.idle`, `session.error`,
  `permission.asked`, `permission.replied`, `tool.execute.before`, `message.updated`. Each
  handler POSTs `{ event, sessionID?, role?, extra? }` to
  `${endpoint}/hook/opencode` with `Authorization: Bearer <token>`, wrapped in try/catch
  (fail-open, never throws into opencode). `sessionID` and `role` are extracted defensively
  from the event's input/output objects (fields optional — payload shapes are not contract).
  `message.updated` is forwarded only when a user role is detectable (turn-start signal);
  assistant streaming updates are dropped at the plugin to avoid POST spam.
- **Normalizer** `normalizeOpencode` in `src/shared/agents/normalize.ts` + dispatch in
  `normalizeFor`. Mapping (event NAME is the contract; payload fields optional):
  - `session.created` → `{ kind: 'session', sessionPhase: 'start', sessionId }`
  - `message.updated` (user role) → `{ kind: 'state', state: 'working', newTurn: true }`
  - `tool.execute.before` → `working`
  - `permission.asked` → `blocked`; `permission.replied` → `working`
  - `session.idle` → `done`; `session.error` → `done`
- Hook server, managed-script, `buildPtyEnv`: untouched (agent-id-parameterized already).
  Server Edition gets badges automatically (same normalize pipeline as codex/gemini).

## 4. Context-link + canvas-control

- Instruction targets: add `~/.config/opencode/AGENTS.md` to BOTH `context-link.ts`
  `installAgentInstructions` targets and `canvas-control.ts` `installAgentInstructions`
  targets (same marker-block merge; opencode reads global AGENTS.md — verified).
- Context-link CLI (`context-link-core.ts` `CLI_SCRIPT`): new branch in `readTranscript` —
  `node.agent === 'opencode'` → `linesFromOpencodeExport(node)`, which runs
  `execFileSync('opencode', ['export', node.sessionId])` (the calling shell's PATH resolves the
  binary — the CLI runs inside an agent's terminal session, not the GUI app) and formats the
  exported JSON defensively (messages array; role + text parts; tool calls abbreviated like the
  codex/gemini formatters). Missing sessionId / spawn failure / unparseable JSON → a friendly
  one-line message (matches existing failure style). `resolveTranscript` keeps returning `''`
  for opencode (no file path — the export branch runs before path resolution). No new locator:
  link files already carry per-entry `sessionId`.
- Discovery notes / note-link push: the non-claude CLI branches cover opencode automatically.

## 5. Icon (`src/renderer/lib/agentIcons.tsx` + asset)

New `src/renderer/assets/opencode.svg` — a simple original mark (terminal-style `[ ]` /
sigil in `#a78bfa` on transparent), NOT a copied trademark asset. Register in `AGENT_LOGO`.

## 6. Testing

- `config` tests: capability membership + `resumeCommand('opencode', …)` cases.
- `normalize.test.ts`: one case per opencode event mapping + unknown-event → null.
- Installer: marker-gated write/remove idempotency (temp-dir fs test, mirroring existing
  hook-installer tests).
- `workspace` tests: `createAgentNode('opencode', …, prompt)` emits `--prompt '…'`;
  claude/codex/gemini command strings byte-identical to before (regression).
- Context-link: `linesFromOpencodeExport` formatting against a fixture export JSON (the
  parser is defensive, so the fixture encodes the shape we accept, not a version contract).
- Live E2E (real session + provider key) is post-merge manual — noted for the user.

## Surfaces

Core + shared + renderer changes serve desktop and Server Edition together (badges work on the
server like codex/gemini; context-tail/subagent extras remain claude-only there, as today).
Remote-SSH hook install: NOT in v1 (`remote-hooks.ts` `AGENT_TARGETS` untouched — opencode
joins codex in the "deferred" note). Mobile: n/a (opencode nodes are ordinary tmux sessions).
