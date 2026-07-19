import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useSession } from '../../session/session'
import { useSettings } from '../../state/settings'
import { LocalTransport } from '../../terminal/local-transport'
import { parseOsc52 } from '../../terminal/osc52'
import {
  attachReplay,
  seedPaint,
  terminalKeyAction,
  xtermScrollback,
  SHIFT_ENTER_SEQ
} from '../../terminal/terminal-config'
import { resolveSshRemote } from '../../nodes/TerminalNode'
import { buildSshArgs, type SshConnection } from '@shared/ssh'

/** The subset of a node's `data` a SECOND client needs to attach to its session the same way the
 *  canvas TerminalNode does. Canvas fills it from the node's data; sticky/chat cards pass `{}`. */
export interface ModalSpawn {
  shell?: string
  cwd?: string
  agentId?: string
  accountId?: string
  /** The node's `data.ssh` — a local `ssh <host>` node runs ssh as its pty program. */
  ssh?: SshConnection
  /** SSH-project node: tmux runs on the REMOTE host (over the project's ControlMaster). */
  sshRemoteTmux?: boolean
}

/**
 * A SECOND live client on the node's tmux session, living only while the card modal is open.
 *
 * It rides the viewer-identity seam (Task 2a): a per-mount `viewerId` makes this a distinct
 * subscriber of the SAME session as the canvas node — its create/resize/kill co-attach and detach
 * independently, so opening or closing the modal never disturbs the canvas node's client (live or
 * parked). Deliberately minimal vs. TerminalNode: NO park, NO WebGL budget, NO hover-guard — a modal
 * is short-lived and always on top. Closing kills ONLY this viewer (the last-view release stays with
 * the canvas node). The MIRROR-tagged blocks below are copied byte-for-byte from TerminalNode.
 */
export function ModalTerminal({ nodeId, spawn }: { nodeId: string; spawn: ModalSpawn }) {
  const { api } = useSession()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // A unique viewerId per mount: the core namespaces it per connection, so uniqueness only has to
    // hold within THIS window. It makes the modal a second subscriber of the node's shared session.
    const viewerId = `modal-${nodeId}-${Math.random().toString(36).slice(2, 8)}`
    const transport = new LocalTransport(api, viewerId)
    const s = useSettings.getState().settings
    const term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      cursorBlink: s.cursorBlink,
      theme: { background: '#161618', foreground: '#e6e6e6' },
      allowProposedApi: true,
      scrollback: xtermScrollback(s.tmuxScrollback),
      macOptionClickForcesSelection: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(hostRef.current!)
    fit.fit()

    let sessionId: string | null = null
    let dead = false
    const cleanups: Array<() => void> = []

    // MIRROR TerminalNode "WRITE-ONLY — `parseOsc52` returns null" — the OSC 52 clipboard-write path.
    // tmux's mouse is ON, so a drag-select in copy-mode emits OSC 52 to this client; this handler
    // writes the system clipboard. `parseOsc52` returns null for a `?` read query so a remote program
    // can never read the local clipboard. Returning true swallows the sequence (also the read query).
    term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52(data)
      if (text !== null) window.nodeTerminal.clipboard.writeText(text)
      return true
    })

    // MIRROR TerminalNode "const action = terminalKeyAction" — Cmd+C / Ctrl+Shift+C / Ctrl+Insert copy
    // the xterm selection (a canvas can't be DOM-copied), and Shift+Enter → ESC+CR (`SHIFT_ENTER_SEQ`)
    // so agent CLIs insert a newline instead of submitting. A copy chord is always swallowed (else
    // Ctrl+Shift+C would fall through to the pty as \x03/SIGINT); plain Ctrl+C is left alone.
    term.attachCustomKeyEventHandler((e) => {
      const action = terminalKeyAction(e, term.hasSelection())
      if (action === 'pass') return true
      e.preventDefault()
      if (action === 'copy') window.nodeTerminal.clipboard.writeText(term.getSelection())
      else if (action === 'shift-enter' && sessionId) transport.write(sessionId, SHIFT_ENTER_SEQ)
      return false
    })

    void (async () => {
      // SSH-project node: resolve the live ControlMaster (may not be up yet on a cold load).
      const sshRemote =
        spawn.sshRemoteTmux && spawn.ssh
          ? await resolveSshRemote(spawn.ssh, spawn.cwd)
          : undefined
      if (dead) return
      // A local `ssh <host>` node runs ssh as its own pty program (shell:'ssh' + buildSshArgs); an
      // SSH-PROJECT node uses tmux on the remote host instead (sshRemote), so it is NOT localSsh.
      const localSsh = !!spawn.ssh && !spawn.sshRemoteTmux
      const res = await transport.create({
        cols: term.cols,
        rows: term.rows,
        shell: localSsh ? 'ssh' : spawn.shell,
        shellArgs: localSsh ? buildSshArgs(spawn.ssh!) : undefined,
        // Don't spawn a LOCAL tmux in a non-existent remote cwd if the master never came up.
        cwd: spawn.sshRemoteTmux && !sshRemote ? undefined : spawn.cwd,
        persistKey: nodeId,
        agentId: spawn.agentId,
        accountId: spawn.accountId,
        sshRemote
      })
      // Another client permanently deleted this node's session — never resurrect it (no live session
      // to join, and the tombstone refused a fresh spawn). Show the state and stop.
      if (res.closed) {
        term.write('\r\n\x1b[90m[session closed by another user]\x1b[0m\r\n')
        return
      }
      // Unmounted while the create was in flight: detach the viewer we just registered so it doesn't
      // linger as a phantom subscriber constraining the shared pty's size.
      if (dead) {
        transport.kill(res.sessionId)
        return
      }
      sessionId = res.sessionId
      cleanups.push(transport.onData(res.sessionId, (d) => term.write(d)))
      cleanups.push(
        transport.onExit(res.sessionId, () =>
          term.write('\r\n\x1b[90m[session ended]\x1b[0m\r\n')
        )
      )
      // The pty runs at the SMALLEST subscriber's grid; render exactly what it tells us and letterbox
      // the rest (the canvas node votes independently — the modal's smaller pane may shrink it).
      if (transport.onSize)
        cleanups.push(
          transport.onSize(res.sessionId, (size) => term.resize(size.cols, size.rows))
        )
      term.onData((d) => sessionId && transport.write(sessionId, d))

      // A fresh (cold-restart / first-open) session's tmux pane is gone, so replay the persisted
      // scrollback. A warm join is painted from the server-captured screen inside create(). Agent
      // auto-resume is deliberately canvas-only — the modal never re-launches a CLI.
      const snapshot = res.fresh ? await api.pty.readScrollback(nodeId) : null
      const paint = seedPaint({
        replay: attachReplay({ parked: false, fresh: res.fresh, hasInitialCommand: false }),
        superseded: false,
        snapshot,
        screen: res.screen
      })
      if (paint === 'snapshot') {
        if (snapshot) term.write(snapshot)
        term.write('\r\n\x1b[90m— cold start · agent auto-resume happens on canvas —\x1b[0m\r\n')
      } else if (paint === 'create-screen' && res.screen) {
        term.write(res.screen)
      }

      const ro = new ResizeObserver(() => {
        fit.fit()
        if (sessionId) transport.resize(sessionId, term.cols, term.rows)
      })
      ro.observe(hostRef.current!)
      cleanups.push(() => ro.disconnect())
      transport.resize(res.sessionId, term.cols, term.rows)
      term.focus()
    })()

    return () => {
      dead = true
      cleanups.forEach((fn) => fn())
      // Kill ONLY this modal's viewer — the instance appends its viewerId. The canvas node's PRIMARY
      // (or parked) client is a different composite subscriber and is untouched; the shared pty lives
      // on until its last view goes.
      if (sessionId) transport.kill(sessionId)
      term.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId])

  return <div ref={hostRef} className="kanban-modal__term" />
}
