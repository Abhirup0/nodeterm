import { describe, it, expect } from 'vitest'

import { tmuxConf } from './pty-manager'

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
})
