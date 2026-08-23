import { Terminal, type ITerminalAddon } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'

// @xterm/addon-serialize's published types are written against @xterm/xterm's (browser) Terminal,
// which has a superset of DOM-specific members @xterm/headless's Terminal lacks. The addon only
// ever touches buffer/modes/cols/rows at runtime — all present on the headless Terminal — so this
// is a real type mismatch between two packages that are runtime-compatible, not a runtime risk.

/**
 * One session's server-side screen. This is the piece that makes the session host able to
 * reconstruct a fresh client's screen on attach WITHOUT itself being a "painter" the way a real
 * tmux client is — see docs/windows-session-host.md ("The seeding trap") before touching any of
 * this, and CLAUDE.md's "Seeding a fresh xterm" section for why a tmux-shaped answer here
 * (seed nothing on warm attach) would ship a blank terminal or duplicated screens depending on
 * which half you got wrong.
 *
 * MODE RESTORATION, VERIFIED NOT ASSUMED: xterm.js's own `SerializeAddon` already restores most
 * DEC private modes as part of its `serialize()` output (bracketed paste, application cursor
 * keys, origin mode, insert mode, reverse-wraparound, send-focus, wraparound, and — when the
 * active buffer is the alternate screen — the `?1049h` switch). Read directly from the compiled
 * `_serializeModes()` in `node_modules/@xterm/addon-serialize/lib/addon-serialize.js` rather than
 * assumed from the docs. It does NOT emit `CSI ?1006h` (SGR extended mouse coordinates) — there
 * is no separate field on the public `IModes` API for it to read; `modes.mouseTrackingMode` only
 * says which tracking PROTOCOL is on (x10/vt200/drag/any), not the coordinate ENCODING. This app
 * always turns mouse tracking on together with SGR (`CO_ATTACH_MOUSE_SEQ` in the renderer mirrors
 * real tmux's `mouse on`, which always pairs `?1000h`/`?1002h` with `?1006h`), so that one
 * sequence is appended by hand below whenever tracking is active. If a future xterm.js version
 * starts emitting it itself, appending it twice is a harmless idempotent DECSET, not a bug.
 */
export class TerminalEmulator {
  private readonly term: Terminal
  private readonly serializer: SerializeAddon
  private readonly defaultScrollback: number

  constructor(opts: { cols: number; rows: number; scrollback: number }) {
    this.defaultScrollback = Math.max(0, opts.scrollback)
    this.term = new Terminal({
      cols: Math.max(1, opts.cols),
      rows: Math.max(1, opts.rows),
      scrollback: this.defaultScrollback,
      allowProposedApi: true
    })
    this.serializer = new SerializeAddon()
    this.term.loadAddon(this.serializer as unknown as ITerminalAddon)
  }

  /**
   * Feed one chunk of PTY output. Resolves once xterm has fully applied it — `Terminal.write`'s
   * own write queue can defer processing of a large chunk past the current tick, and a caller
   * that called `serialize()` without waiting for this would race a partially-applied write (the
   * screen it hands back could be missing the tail of what just arrived).
   */
  write(data: string): Promise<void> {
    return new Promise((resolve) => this.term.write(data, resolve))
  }

  resize(cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.term.resize(cols, rows)
  }

  /**
   * The reconstructed screen: serialized content (scrollback capped at `scrollback`, defaulting
   * to this emulator's construction-time cap — smaller for `captureSession`'s "recent lines"
   * callers) plus the mode-restore/alt-buffer/cursor tail `SerializeAddon` already produces, with
   * the SGR-mouse gap above patched in by hand. Returns '' for a session that has never painted
   * anything (a cold session moments after spawn) — callers treat '' the same way the rest of
   * this app already treats an empty tmux capture: "nothing to seed", never a screen reset.
   */
  serialize(scrollback = this.defaultScrollback): string {
    let out = this.serializer.serialize({ scrollback: Math.max(0, scrollback) })
    if (this.term.modes.mouseTrackingMode !== 'none' && !out.includes('\x1b[?1006h')) {
      out += '\x1b[?1006h'
    }
    return out
  }

  dispose(): void {
    try {
      this.serializer.dispose()
    } catch {
      /* already disposed */
    }
    try {
      this.term.dispose()
    } catch {
      /* already disposed */
    }
  }
}
