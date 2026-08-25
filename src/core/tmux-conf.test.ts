import { describe, it, expect } from 'vitest'

import { tmuxConf } from './pty-manager'
import { leadPaneHookLines } from '../shared/tmux-lead-pane'

describe('tmuxConf', () => {
  const c = tmuxConf(50000)

  it('leaves the mouse ON — tmux owns scrolling and selection', () => {
    // The wheel scrolls tmux's own history and the pane stays on the alternate screen (so a TUI's
    // input box stays put). The previous design (mouse off, emulator-owned scrollback) leaked
    // tmux's repaints into the scrollback as black bands and duplicated screens.
    expect(c).toContain('set -g mouse on')
    expect(c).not.toContain('set -g mouse off')
  })

  it('does not blank smcup/rmcup/indn — the alternate screen is the native, wanted behavior', () => {
    expect(c).not.toContain('smcup@')
    expect(c).not.toContain('rmcup@')
    expect(c).not.toContain('indn@')
  })

  it('enables OSC 52 via terminal-features, NOT the Ms= override (a no-op on tmux 3.2+)', () => {
    // Measured on tmux 3.4: with `terminal-overrides ,xterm*:Ms=...` a copy emitted ZERO OSC 52 to
    // the attached client; with the `clipboard` terminal-feature it emitted the correct payload.
    expect(c).toContain('set -g set-clipboard on')
    expect(c).toContain('set -as terminal-features ",*:clipboard"')
    expect(c).not.toContain('Ms=')
  })

  it('declares RGB via terminal-features so truecolor is not clamped to 256 colors (issue #78)', () => {
    // Without an RGB terminal-features (or Tc) entry for the outer terminal, tmux quantizes every
    // 24-bit SGR to the 256-color palette — canvas terminals never match the user's real terminal.
    expect(c).toContain('set -as terminal-features ",*:RGB"')
    // Only via terminal-features: the overrides array must stay unset (see the MIGRATION note).
    expect(c).not.toMatch(/set -a[gs]? terminal-overrides/)
  })

  it('declares hyperlinks via terminal-features so OSC 8 links reach the renderer', () => {
    // tmux strips the OSC 8 escape unless the outer terminal declares support, leaving only the
    // label text — a link whose URL is not also printed can then never be opened.
    expect(c).toContain('set -as terminal-features ",*:hyperlinks"')
  })

  it('copies mouse selections through tmux (OSC 52), with no macOS-only pbcopy pipe', () => {
    expect(c).toContain('bind -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel')
    expect(c).toContain('bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel')
    expect(c).toContain('DoubleClick1Pane send-keys -X select-word')
    expect(c).toContain('TripleClick1Pane send-keys -X select-line')
    // pbcopy is macOS-only — half of why copying never worked elsewhere or over SSH.
    expect(c).not.toContain('pbcopy')
  })

  it('floors history-limit at 1000', () => {
    expect(tmuxConf(10)).toContain('set -g history-limit 1000')
    expect(c).toContain('set -g history-limit 50000')
  })

  it('lead-pane width OFF (default/0/invalid) is byte-identical and carries no set-hook (issue #119)', () => {
    // The opt-in guarantee enes set for the feature: with the setting off, the generated conf is
    // bit-for-bit the pre-feature output — nodeterm ships no tmux hooks unless asked to.
    expect(tmuxConf(50000, 0)).toBe(c)
    expect(tmuxConf(50000, NaN)).toBe(c)
    expect(tmuxConf(50000, -3)).toBe(c)
    expect(c).not.toContain('set-hook')
  })

  it('lead-pane width ON only APPENDS the shared guarded hook pair — nothing above changes', () => {
    const on = tmuxConf(50000, 72)
    expect(on.startsWith(c)).toBe(true)
    expect(on).toContain(leadPaneHookLines(72))
    // Same builder as remoteTmuxConf, so the local and SSH sockets cannot drift.
    expect(on).toContain('set-hook -g after-resize-pane')
    expect(on).toContain('set-hook -g after-split-window')
  })
})
