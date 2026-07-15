# Tester-feedback improvements — design

**Date:** 2026-07-15
**Status:** approved (design reviewed in-session)
**Source:** first-run field report from an external tester (opencode user, Claude Code pointed
at z.ai GLM-5.2/4.7). Every item below is grounded in code, not just the report.

## Background — feedback → root cause

| # | Feedback | Root cause (verified) |
|---|----------|----------------------|
| P1 | "Split this task to subagents" created 3 groups + 3 agent nodes, but none auto-started; each needed a manual `'` + Enter | Not a quoting bug — `shellSingleQuote` (`src/renderer/state/workspace.ts:127`) is POSIX-correct. `writeWhenShellReady` (`src/renderer/nodes/TerminalNode.tsx:1082-1102`) delivers the composed command on a pure timing heuristic (200 ms quiet / 1500 ms cap). Slow shell init (heavy rc, nvm) or CPU contention from 3 simultaneous spawns lets zsh's tty FLUSH eat part of the queued line → odd quote count → `quote>` continuation prompt. Typing `'` + Enter is exactly the recovery for that state. |
| P2 | Clicked the tmux-banner Install button, got no feedback, couldn't tell if it worked; installed by hand and restarted | `TmuxBanner.tsx:48-51` dismisses the banner optimistically on click. No installing/success/failure state; `tmuxPath` is resolved only in `PtyManager.init()` (`src/core/pty-manager.ts:539`), so even a successful install needs a restart — and nothing says so on the button path. |
| P3 | First Claude session used zero nodeterm capabilities | Canvas-control discovery relies entirely on Claude Code's SKILL.md description auto-trigger (`src/main/canvas-control.ts:48`). No session-level hint exists; non-Anthropic models (GLM) may never surface the skill. |
| P4a | "Didn't know what to do first"; went to the website looking for docs | WelcomeScreen offers 4 actions, but the empty canvas after opening a project has zero guidance. Help menu links only to the GitHub repo — no docs entry. |
| P4b | Top-right icons too small; Explorer icon unreadable | All toolbar buttons are 34 px with 15 px glyphs; Explorer is a raw 🗂 emoji (`Canvas.tsx:5547`), mixed with text glyphs (`⌕`, `⚙`, `?`) and small SVGs. |
| — | Quota ran out mid-task (z.ai) | Out of scope — third-party endpoint quota; the usage indicator is Claude-account-only by design. |

## P1 — echo-verified initialCommand delivery

**Goal:** a spawned agent node's launch command either runs intact or retries — a mangled line
is never submitted.

**Approach (chosen over alternatives):** echo-verify + retry.
- Write the command **without** the trailing newline.
- Accumulate the session's output; on an ANSI-stripped view, wait until the **tail** of the
  command (last ~24 chars) appears — the shell has echoed the full line. Tail-match (not
  full-match) tolerates ZLE redraw/wrap sequences interleaved in the echo.
- On match → send `\r` (submit). On verify timeout (~2 s) → send `\x15` (Ctrl-U, kill line)
  and rewrite; max 3 attempts, then fall back to today's fire-and-forget write so a bizarre
  TERM never blocks the launch (fail-open).
- Keep a settle delay before the first write (today's quiet-gap detector stays as the initial
  wait), because writing into a mid-init tty wastes an attempt even when verification would
  catch it.

Rejected: PS1/sentinel prompt detection (requires injecting into user rc files); timing bumps
alone (still best-effort).

**Placement:** the verifier is a pure module (`src/renderer/terminal/command-delivery.ts` or
similar): `stripAnsi(chunk)` accumulation + `tailMatched(buffer, cmd)` + the retry state
machine, unit-tested (this path currently has zero tests). `TerminalNode.tsx` wires it to
`transport.onData`/`transport.write`. All `initialCommand` consumers heal at once: agent
spawn, `spawn-team`, cold-restore resume, gh sign-in, the tmux install command.

**Surfaces:** renderer-only → desktop + Server Edition automatically. Mobile n/a (no
initialCommand concept in the companion).

## P2 — tmux banner state machine + restart-free pickup

**Renderer (`TmuxBanner.tsx`):** states `missing → installing → ready | failed`.
- Click no longer dismisses. Banner shows "Installing tmux…" and polls `pty.tmuxStatus()`
  every ~3 s.
- `available: true` → "tmux ready — new terminals will use it" (auto-hide after a few
  seconds). Existing plain-shell terminals stay as they are; the copy says so.
- Cap (~5 min) without success → failed state: retry button + the manual-install text
  (package-manager command + restart hint). The raw install output is already visible in the
  spawned terminal node; the banner only reports the outcome.

**Core (`src/core/pty-manager.ts`):** extract `init()`'s tmux tail (findTmux + conf write +
`source-file` push) into `ensureTmux()`. `tmuxStatus()` re-runs it when `tmuxPath === null`,
so after a successful install **new** sessions are tmux-backed without a restart. `ensureTmux`
is idempotent and cheap-fails (probe result memoized per call, not cached-forever).

**Surfaces:** core change → desktop + Server Edition. win32 stays hidden. Mobile n/a.

## P3 — canvas-control discoverability

- **SKILL.md description** (`src/main/canvas-control.ts:48`): broaden triggers — parallelize,
  delegate, work in parallel, split across agents/terminals, organize the canvas, open a
  terminal/editor. Mirror the same wording into the codex/gemini AGENTS.md marker blocks
  (`canvas-control-core.ts`).
- **Idle-gated session note** (same pattern as the context-link connect note): when an agent
  node's session starts (session id seen from hooks), push once per session, at an idle
  moment, a single line telling the agent it can control the canvas and how (skill name for
  claude; `nodeterm.sh` CLI for codex/gemini). Only for nodes that carry
  `NODETERM_CANVAS_CONTROL` in their env; never for plain terminals. This is what makes
  discovery work for models that ignore skill auto-triggering (GLM et al.).
- Canvas-control is not wired on the Server Edition yet (known gap, tracked separately);
  this work is desktop-scoped and must not widen that gap.

## P4 — empty-canvas hint + toolbar polish

- **Ghost hint:** when the active project's canvas has 0 nodes, render a centered,
  low-opacity, non-interactive block: "Right-click to add a terminal · ⌘K for commands ·
  + in the dock below". Disappears as soon as any node exists. Pure renderer, no persisted
  state, shown on every empty canvas (not first-run-only — YAGNI).
- **Toolbar icons:** replace the 🗂 emoji with an SVG file-tree icon in
  `components/icons.tsx`; convert `⌕` and `⚙` glyphs to SVGs too; icon size 15 → 18 px
  (buttons stay 34 px). Tooltips unchanged.
- **Help menu:** add a "Documentation" entry. Target: the GitHub README
  (`REPO_URL` in `lib/bugReport.ts`) for now; swap to a dedicated docs URL when one exists
  (one-line change).
- Out of scope (explicitly decided): step-by-step coach-mark tour; larger buttons.

## Order & testing

Implement P1 → P2 → P3 → P4; independent, separate commits/PRs.
- P1: unit tests for the delivery verifier (strip/tail-match/retry transitions).
- P2: unit tests for `ensureTmux` (injected probe) and the banner state logic.
- P3: idempotency tests for the marker/skill install already exist — extend for new wording;
  note-push gating gets a unit test.
- P4: render-condition test for the ghost hint (0 nodes ↔ ≥1 node).
