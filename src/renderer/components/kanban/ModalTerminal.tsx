import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { hasUsage } from '@shared/agents/config'
import { FindBar } from '../FindBar'
import { useAgentStatus } from '../../state/agentStatus'
import { useProjects } from '../../state/projects'
import { useSession } from '../../session/session'
import { useSettings } from '../../state/settings'
import { useTerminalSearch } from '../../terminal/useTerminalSearch'
import { LocalTransport } from '../../terminal/local-transport'
import { droppedPaths, pastedFiles } from '../../terminal/file-drop'
import { parseOsc52 } from '../../terminal/osc52'
import {
  attachReplay,
  seedPaint,
  stripTrailingNewline,
  terminalKeyAction,
  toXtermText,
  xtermScrollback,
  SHIFT_ENTER_SEQ,
  CO_ATTACH_MOUSE_SEQ
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
interface ModalTerminalProps {
  nodeId: string
  spawn: ModalSpawn
  /** The modal header's 🔍 toggle — the FindBar renders inside this pane. */
  searchOpen: boolean
  onCloseSearch: () => void
}

export function ModalTerminal({ nodeId, spawn, searchOpen, onCloseSearch }: ModalTerminalProps) {
  const { api } = useSession()
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const agentSessionId = useAgentStatus((s) => s.byId[nodeId]?.sessionId)
  const [dropping, setDropping] = useState(false)
  const [uploading, setUploading] = useState(false)

  // Same search machinery as the canvas node: capture-indexed matches + xterm highlight.
  const readBuffer = useCallback((): string => {
    const b = termRef.current?.buffer.active
    if (!b) return ''
    const lines: string[] = []
    for (let i = 0; i < b.length; i++) lines[i] = b.getLine(i)?.translateToString() ?? ''
    return lines.join('\n')
  }, [])
  const search = useTerminalSearch({
    nodeId,
    sessionId: agentSessionId,
    cwd: spawn.cwd,
    accountId: spawn.accountId,
    searchTranscript: !!spawn.agentId && hasUsage(spawn.agentId),
    open: searchOpen,
    readBuffer
  })
  // MIRROR TerminalNode's findOpts — one source for the highlight colors.
  const findOpts = {
    decorations: {
      matchBackground: '#ffd54f55',
      activeMatchBackground: '#ffb300',
      matchOverviewRuler: '#ffd54f',
      activeMatchColorOverviewRuler: '#ffb300'
    }
  }
  const handleNext = useCallback(() => {
    search.next()
    if (search.query.trim()) searchAddonRef.current?.findNext(search.query, findOpts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])
  const handlePrev = useCallback(() => {
    search.prev()
    if (search.query.trim()) searchAddonRef.current?.findPrevious(search.query, findOpts)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

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
    const searchAddon = new SearchAddon()
    term.loadAddon(searchAddon)
    termRef.current = term
    searchAddonRef.current = searchAddon
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
      // DELIBERATELY omitted vs. TerminalNode: no flow-control pause (transport.setFlow) and no
      // onResync handler. The pty's pacing/backpressure comes from the canvas node's client — the
      // modal is a transient, always-on-top second view and never drives the shared session's flow.

      // A fresh (cold-restart / first-open) session's tmux pane is gone, so replay the persisted
      // scrollback. A warm join is painted from the server-captured screen inside create(). Agent
      // auto-resume is deliberately canvas-only — the modal never re-launches a CLI. Both the
      // snapshot and `res.screen` come from `capture-pane -p` (LF-separated, no CR bytes) and this
      // xterm runs with convertEol:false, so they MUST go through toXtermText or they staircase.
      const snapshot = res.fresh ? await api.pty.readScrollback(nodeId) : null
      // The read above is a suspension point: bail if the modal closed while it was in flight, so we
      // never write into a disposed xterm or observe a null host ref (mirrors TerminalNode's
      // post-await onDisposed check).
      if (dead) return
      const paint = seedPaint({
        replay: attachReplay({ parked: false, fresh: res.fresh, hasInitialCommand: false }),
        superseded: false,
        snapshot,
        screen: res.screen
      })
      if (paint === 'snapshot') {
        if (snapshot) term.write(toXtermText(snapshot))
        term.write('\r\n\x1b[90m— cold start · agent auto-resume happens on canvas —\x1b[0m\r\n')
      } else if (paint === 'create-screen' && res.screen) {
        // Start from a known-clean SGR state, then convert the capture's LFs to CRLFs.
        term.write('\x1b[0m' + toXtermText(stripTrailingNewline(res.screen)))
      }

      // Co-attach joiners miss the mouse-tracking mode tmux only sends at its own attach, so the
      // wheel can't scroll tmux history until a keystroke wakes it. Enable it here (see
      // CO_ATTACH_MOUSE_SEQ). Painting content first, then the modes, keeps the seed untouched.
      if (res.coAttachMouse) term.write(CO_ATTACH_MOUSE_SEQ)

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

  // File drop → paste the path(s) into the co-attached session, just like the canvas node.
  const onDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropping) setDropping(true)
  }
  const onDragLeave = (e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null
    if (!rt || !(e.currentTarget as HTMLElement).contains(rt)) setDropping(false)
  }
  /** Drop and paste share one path — same rule as the canvas node (see TerminalNode.insertFiles):
   *  files become paths in the terminal, and only the window-raise differs. */
  const insertFiles = async (files: File[], opts: { raiseWindow: boolean }) => {
    const term = termRef.current
    if (!term || !files.length) return
    // Clipboard bytes must be written before they have a path, which is not instant either.
    const needsWrite = files.some((f) => !window.nodeTerminal.getPathForFile(f))
    let paths: string[]
    if (spawn.sshRemoteTmux) {
      const projectId = useProjects.getState().activeProjectId
      setUploading(true)
      try {
        paths = await droppedPaths(files, { sshRemoteTmux: true, projectId })
      } finally {
        setUploading(false)
      }
    } else if (needsWrite) {
      setUploading(true)
      try {
        paths = await droppedPaths(files, { sshRemoteTmux: false, projectId: '' })
      } finally {
        setUploading(false)
      }
    } else {
      paths = await droppedPaths(files, { sshRemoteTmux: false, projectId: '' })
    }
    if (!paths.length) return
    // A drag-drop from another OS app doesn't bring our window forward (esp. macOS), so the
    // drag-source keeps keyboard focus — the user's next keystrokes would land in the wrong app.
    // Raise our window FIRST, then focus the terminal, so typing after the drop reaches it.
    // A paste came from this window, which already has focus.
    if (opts.raiseWindow) window.nodeTerminal.focusWindow()
    term.focus()
    term.paste(paths.join(' ') + ' ')
  }

  const onDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files)
    setDropping(false)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    await insertFiles(files, { raiseWindow: true })
  }

  // Cmd/Ctrl+V of a file or of raw image bytes; a text paste falls through to xterm untouched.
  // Capture phase, because xterm's own paste listener sits on the textarea below this wrapper.
  const onPaste = (e: React.ClipboardEvent) => {
    const files = pastedFiles(e.clipboardData)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    void insertFiles(files, { raiseWindow: false })
  }

  return (
    <div
      className={`kanban-modal__termwrap${dropping ? ' kanban-modal__termwrap--drop' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onPasteCapture={onPaste}
    >
      {uploading && <div className="kanban-modal__upload">Uploading…</div>}
      {searchOpen && (
        <FindBar
          query={search.query}
          onQueryChange={search.setQuery}
          matchIndex={search.matchIndex}
          matchCount={search.matchCount}
          current={search.current}
          onNext={handleNext}
          onPrev={handlePrev}
          onClose={onCloseSearch}
        />
      )}
      <div ref={hostRef} className="kanban-modal__term" />
    </div>
  )
}
