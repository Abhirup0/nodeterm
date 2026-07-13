// Ensure Claude Code's fullscreen rendering (`"tui": "fullscreen"` in settings.json). That setting
// is what makes a Claude session take the alternate screen + mouse, so it behaves natively inside
// nodeterm's tmux instead of dropping drags into tmux's copy-mode (yellow selection + counter).
//
// Two hard guardrails, both enforced here:
//   - WRITE-IF-ABSENT: if the `tui` key already exists with ANY value, leave it untouched — a user
//     who ran `/tui default` has spoken, and `/tui` always has the last word (no nodeterm toggle).
//   - VERSION-GATED at the CALL SITE: only run this when the CLI is known to be >= 2.1.89
//     (FULLSCREEN_TUI_MIN_VERSION). This pure helper does not know the version; callers gate it.
//
// Merge semantics mirror install-helper.ts: pure transform on a parsed object (`ensureFullscreenTui`)
// plus a thin fail-open file wrapper (`ensureFullscreenTuiInFile`) that tolerates a missing/empty/
// corrupt settings.json the same way (defaults to `{}`), and only writes when something changed.
import path from 'path'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

/** The settings.json value that turns on Claude's fullscreen rendering. */
export const TUI_FULLSCREEN = 'fullscreen'

/** A subset of Claude's settings.json — we only reason about the `tui` key; everything else rides. */
export type TuiSettings = { tui?: unknown; [k: string]: unknown }

/**
 * Pure: ensure `"tui": "fullscreen"` ONLY when the `tui` key is absent. When it already exists
 * (any value — `"default"`, `"fullscreen"`, or garbage), the object is returned untouched and
 * `changed` is false so the caller skips the write. Every other key is preserved.
 */
export function ensureFullscreenTui(config: TuiSettings): { config: TuiSettings; changed: boolean } {
  if ('tui' in config) return { config, changed: false }
  return { config: { ...config, tui: TUI_FULLSCREEN }, changed: true }
}

/**
 * Fail-open file wrapper for the local surfaces (system `~/.claude` + managed account dirs). Reads
 * `configPath`, applies `ensureFullscreenTui`, and writes back ONLY if the key was added. Returns
 * whether it wrote. A read or write error is swallowed + warned, never thrown.
 *
 * A file that EXISTS but does not parse is left completely alone — unlike install-helper, which
 * normalizes it. The hook merge usually runs first and normalizes a corrupt file, but when it bails
 * early (its managed-script write failed) this pass would be the FIRST writer, and "replace the
 * user's settings with {tui:...}" is data loss a cosmetic rendering default can never justify.
 * Only a genuinely missing/empty file is treated as `{}`.
 */
export function ensureFullscreenTuiInFile(configPath: string): boolean {
  let config: TuiSettings = {}
  let raw: string | null = null
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    raw = null // missing/unreadable → create from {}
  }
  if (raw !== null && raw.trim() !== '') {
    try {
      config = JSON.parse(raw) as TuiSettings
    } catch {
      return false // exists but unparseable: never replace the user's file
    }
  }
  const { config: next, changed } = ensureFullscreenTui(config)
  if (!changed) return false
  try {
    mkdirSync(path.dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8')
    return true
  } catch (e) {
    console.warn('[claude-tui] fullscreen tui write failed', e)
    return false
  }
}
