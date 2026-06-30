import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Handle,
  NodeResizer,
  Position,
  useReactFlow,
  useUpdateNodeInternals,
  type NodeProps
} from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { renderMarkdown } from '../lib/markdown'
import { ChatPanel } from './ChatPanel'
import { transport as localTransport } from '../terminal/local-transport'
import { RemoteTransport } from '../terminal/remote-transport'
import type { TerminalTransport } from '../terminal/transport'
import { patchTerminalScale } from '../terminal/scale-fix'
import { parseOsc52 } from '../terminal/osc52'
import { FindBar } from '../components/FindBar'
import { IconSearch } from '../components/icons'
import { NodeTags } from '../components/NodeTags'
import { Tooltip } from '../components/Tooltip'
import { useTerminalSearch } from '../terminal/useTerminalSearch'
import { ContextMeter } from '../components/ContextMeter'
import { isZoomModifierHeld } from '../lib/zoomModifier'
import { useSettings } from '../state/settings'
import { useAgentStatus } from '../state/agentStatus'
import { useAgentNodes } from '../state/agentNodes'
import { useProjects } from '../state/projects'
import { useSshConn } from '../state/sshConn'
import { COLLAPSED_HEIGHT, NODE_COLORS, type CanvasNode } from '../state/workspace'
import { hasHooks, canRecur, canContextLink, hasUsage, canChat, canResume, canRename, resumeCommand, agentConfig, type AgentId } from '@shared/agents/config'
import { buildSshArgs, type SshConnection } from '@shared/ssh'

/** Backslash-escape shell-special characters, like a native terminal does on file drop. */
function escapeDroppedPath(p: string): string {
  return p.replace(/([ \t"'`\\()&;|<>$!*?[\]{}#~])/g, '\\$1')
}

/**
 * Resolve the `sshRemote` create option for an SSH-project terminal: the owning project's live
 * ControlMaster `controlPath` (set by Canvas's active-project effect on connect) plus the inline
 * connection and remote cwd. The controlPath may not be ready yet on a cold app load (child
 * effects run before the parent's connect resolves), so wait for it — briefly — before spawning.
 * Returns undefined if no master appears within the window (connection failed); the caller then
 * degrades gracefully instead of spawning a local tmux in a non-existent remote directory.
 */
async function resolveSshRemote(
  conn: SshConnection,
  cwd: string | undefined
): Promise<
  | {
      controlPath: string
      conn: SshConnection
      remoteCwd: string
      hookEndpointPath?: string
      tmuxConfPath?: string
    }
  | undefined
> {
  const projectId = useProjects.getState().activeProjectId
  let controlPath = useSshConn.getState().getControlPath(projectId)
  if (!controlPath) {
    controlPath = await new Promise<string | undefined>((resolve) => {
      let settled = false
      const finish = (v?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsub()
        resolve(v)
      }
      const unsub = useSshConn.subscribe((s) => {
        const v = s.byProject[projectId]?.controlPath
        if (v) finish(v)
      })
      const timer = setTimeout(() => finish(useSshConn.getState().getControlPath(projectId)), 20000)
    })
  }
  if (!controlPath) return undefined
  // The remote hook endpoint (reverse tunnel + remote install) is set up alongside the master;
  // pass it through so the remote tmux session carries the hook env. Optional (fail-open).
  const hookEndpointPath = useSshConn.getState().getHookEndpointPath(projectId)
  // The remote tmux config (mouse on → scroll; set-clipboard on → OSC 52) is written + sourced
  // alongside the master; pass its path so a fresh remote session launches with `-f`. Optional.
  const tmuxConfPath = useSshConn.getState().getTmuxConfPath(projectId)
  return { controlPath, conn, remoteCwd: cwd || '~', hookEndpointPath, tmuxConfPath }
}

/**
 * Move-into-worktree handler bridge. Like GroupNode's worktree-action bridge: React Flow
 * instantiates custom nodes itself, so Canvas can't pass this callback through props. Canvas
 * registers its handler here on mount; the "↪" header action calls it with the node id.
 */
let moveIntoWorktreeHandler: ((nodeId: string) => void) | null = null
export function setMoveIntoWorktreeHandler(fn: ((nodeId: string) => void) | null): void {
  moveIntoWorktreeHandler = fn
}

/**
 * A single terminal node: header (collapse + color + title + close), optional tag chips,
 * and a real xterm.js terminal. A hover guard delays entering the terminal so the canvas
 * can be panned across terminals without grabbing focus. Cmd/Ctrl+M (while hovered)
 * toggles a markdown view of the terminal's output. Files dropped from Finder are pasted
 * as their (escaped) paths, like a native terminal — so Claude can read dropped images.
 */
export function TerminalNode({ id, data, selected, parentId }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, getZoom, setNodes, getNode } = useReactFlow()
  // Pick the session layer: a remote-bound node (data.remote) talks to a host over the relay
  // via RemoteTransport; otherwise the local PTY (LocalTransport). The connectionId is stable
  // for a node's lifetime, so the instance is created once and held in a ref.
  const transportRef = useRef<TerminalTransport | null>(null)
  if (!transportRef.current) {
    const conn = (data.remote as { connectionId: string } | undefined)?.connectionId
    transportRef.current = conn ? new RemoteTransport(conn) : localTransport
  }
  const transport = transportRef.current
  // Scoped selectors (not the whole settings object) so this node only re-renders when a
  // field it actually uses changes — not on every unrelated settings edit.
  const panHoverDelay = useSettings((s) => s.settings.panHoverDelay)
  const fontSize = useSettings((s) => s.settings.fontSize)
  const fontFamily = useSettings((s) => s.settings.fontFamily)
  const cursorBlink = useSettings((s) => s.settings.cursorBlink)
  const bodyRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const searchAddonRef = useRef<SearchAddon | null>(null)
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showColors, setShowColors] = useState(false)
  const [armed, setArmed] = useState(true)
  const [dropping, setDropping] = useState(false)
  const [naming, setNaming] = useState(false)
  const [mdHtml, setMdHtml] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const hoveredRef = useRef(false)
  // Live mirrors for the once-mounted onTitleChange listener (its `[]`-deps closure can't see
  // fresh props/state): whether the title still auto-tracks the session, whether the rename box
  // is open (don't clobber mid-edit), and the current title (skip no-op updates).
  const titleAutoRef = useRef(data.titleAuto !== false)
  const editingTitleRef = useRef(false)
  const titleRef = useRef(data.title as string)
  // Rename-box bookkeeping: the value when editing began (for Escape-revert) and a one-shot
  // flag so the blur that follows Enter/Escape doesn't commit a second time.
  const titleEditStartRef = useRef('')
  const skipBlurRef = useRef(false)
  const mdMode = !!data.mdMode
  const collapsed = !!data.collapsed
  const tags = (data.tags as string[]) ?? []
  // Derive the node's agent once. The `tags` fallback keeps not-yet-migrated legacy
  // claude nodes working until they're re-serialized with `agentId`.
  const agentId = (data.agentId as AgentId | undefined) ?? (tags.includes('claude') ? 'claude' : undefined)
  // Gate each former `isClaude` site by the capability it actually represents.
  const showStatus = !!agentId && hasHooks(agentId) // status badge + session-title capture
  const showLoop = !!agentId && canRecur(agentId) // /loop · /schedule · /cron chrome
  const showLink = !!agentId && canContextLink(agentId) // context-link handles
  const showUsage = !!agentId && hasUsage(agentId) // per-node context-window meter
  const showChat = !!agentId && canChat(agentId) // Cmd+M opens a chat panel instead of markdown
  const canRenameNode = !!agentId && canRename(agentId) // title ⇄ session-name two-way sync
  const agentLabel = (agentId ? agentConfig(agentId) : undefined)?.label ?? 'Agent'

  // Keep the listener's mirrors current every render.
  titleAutoRef.current = data.titleAuto !== false
  editingTitleRef.current = editingTitle
  titleRef.current = data.title as string
  // "Move into worktree" affordance: shown only when this terminal is a child of a group that
  // is bound to a worktree AND its current cwd differs from that worktree path (i.e. it's still
  // running in the old folder). Reads the parent group from React Flow state (single source of
  // truth); `parentId` is set by the group reparenting transforms.
  const parentWtPath = parentId
    ? ((getNode(parentId) as CanvasNode | undefined)?.data.worktree?.path as string | undefined)
    : undefined
  const canMoveIntoWorktree = !!parentWtPath && (data.cwd as string | undefined) !== parentWtPath
  const status = useAgentStatus((s) => s.byId[id])
  // Use the chat panel only for a chat-capable agent with a known session; otherwise the
  // markdown-of-output view (computed in the capture effect below) is shown as a fallback.
  const useChat = mdMode && showChat && !!status?.sessionId
  // Feed the context meter without waiting for a live hook event: after an app restart the
  // continuing tmux session is idle and emits no event, so the main-process tailer is never
  // re-fed. Re-runs if the sessionId changes (track is idempotent). cwd is a path fallback.
  useEffect(() => {
    const sid = status?.sessionId
    if (showUsage && sid) window.nodeTerminal.context.ensure(sid, (data.cwd as string) || undefined)
  }, [showUsage, status?.sessionId, data.cwd])
  const updateNodeInternals = useUpdateNodeInternals()

  const [searchOpen, setSearchOpen] = useState(false)

  // Stable fallback reader: serialize the live xterm buffer when tmux capture is unavailable.
  const readBuffer = useCallback(() => {
    const t = termRef.current
    if (!t) return ''
    const b = t.buffer.active
    let s = ''
    for (let i = 0; i < b.length; i++) s += (b.getLine(i)?.translateToString() ?? '') + '\n'
    return s
  }, [])

  const search = useTerminalSearch({
    nodeId: id,
    sessionId: status?.sessionId,
    cwd: data.cwd as string | undefined,
    searchTranscript: showUsage,
    open: searchOpen,
    readBuffer
  })

  // Single source of truth for the on-screen highlight colors (used by both the
  // initial-highlight effect and the prev/next nav handlers below).
  const findOpts = {
    decorations: {
      matchBackground: '#ffd54f55',
      activeMatchBackground: '#ffb300',
      matchOverviewRuler: '#ffd54f',
      activeMatchColorOverviewRuler: '#ffb300'
    }
  }

  // Navigation steps the hook's authoritative cursor AND xterm's on-screen highlight.
  // The two intentionally desync (the hook also counts transcript-only matches that
  // xterm can't highlight) — that's expected; this only tracks navigation direction.
  const handleNext = useCallback(() => {
    search.next()
    if (search.query.trim()) searchAddonRef.current?.findNext(search.query, findOpts)
  }, [search])
  const handlePrev = useCallback(() => {
    search.prev()
    if (search.query.trim()) searchAddonRef.current?.findPrevious(search.query, findOpts)
  }, [search])

  // The link handles are added/positioned dynamically for context-link-capable nodes; make
  // React Flow re-measure them so edges anchor to the (centered) handle, not a stale position.
  useEffect(() => {
    if (showLink) updateNodeInternals(id)
  }, [showLink, id, updateNodeInternals])

  // Terminal lifecycle — set up once on mount, and again whenever `respawnNonce` is bumped
  // (e.g. moving this terminal into a worktree). Bumping the nonce runs the cleanup below
  // (kill the old session + dispose xterm), then recreates the session with the latest
  // `data.cwd`. The node `id` (= tmux persistKey) is unchanged, so it's the same target.
  useEffect(() => {
    const container = bodyRef.current
    if (!container) return

    const s = useSettings.getState().settings
    const term = new Terminal({
      fontFamily: s.fontFamily,
      fontSize: s.fontSize,
      cursorBlink: s.cursorBlink,
      theme: { background: '#1e1e1e', foreground: '#e6e6e6' },
      allowProposedApi: true
    })
    termRef.current = term
    const fit = new FitAddon()
    fitRef.current = fit
    term.loadAddon(fit)
    const searchAddon = new SearchAddon()
    searchAddonRef.current = searchAddon
    term.loadAddon(searchAddon)
    term.open(container)
    fit.fit()
    patchTerminalScale(term, getZoom)

    // OSC 52 clipboard write: the remote tmux (set-clipboard on) emits OSC 52 on copy; route the
    // decoded text to the Mac clipboard. WRITE-ONLY — `parseOsc52` returns null for a `?` read
    // query so a remote program can never read the local clipboard. Returning true swallows the
    // sequence (also the read query). This is additive: the local tmux conf also has set-clipboard
    // on, so local tmux DOES emit OSC 52 and this handler fires too — a harmless redundant write of
    // the same selection (pbcopy already wrote it), NOT a no-op.
    term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52(data)
      if (text !== null) window.nodeTerminal.clipboard.writeText(text)
      return true
    })

    // Cmd+C copies the terminal selection (xterm renders to canvas, so the DOM-selection
    // copy used elsewhere can't see it). Ctrl+C is left alone so it still sends SIGINT.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'c') {
        if (term.hasSelection()) {
          window.nodeTerminal.clipboard.writeText(term.getSelection())
          return false
        }
      }
      return true
    })

    let sessionId: string | null = null
    let disposed = false
    const cleanups: Array<() => void> = []

    // Remote nodes: surface a dropped relay connection (host gone / socket closed) so the
    // terminal isn't silently frozen. The actual relay teardown on node *deletion* happens
    // in Canvas.deleteNodes (which can dedupe a connectionId shared by sibling nodes).
    const remoteConn = (data.remote as { connectionId: string } | undefined)?.connectionId
    if (remoteConn) {
      cleanups.push(
        window.nodeTerminal.remoteClient.onClosed(remoteConn, () => {
          term.write('\r\n\x1b[31m[remote disconnected]\x1b[0m\r\n')
        })
      )
    }

    // Agent state (busy/idle/attention) comes from the agent's own hooks via the
    // agent:status IPC (handled centrally in Canvas) — not from parsing the output here.
    // We only surface the conversation topic from the terminal title, when the agent sets one.
    if (showStatus) {
      cleanups.push(
        term.onTitleChange((t) => {
          const title = t.trim()
          // Ignore path/prompt-like titles (e.g. "user@host: ~/dir") which aren't session names.
          // This feeds the `session` chip only; the node title is synced from the transcript's
          // authoritative session name instead (see the readSessionName effect below).
          if (title && !/[/:~]/.test(title)) useAgentStatus.getState().setSession(id, title)
        }).dispose
      )
    }

    const ssh = data.ssh as SshConnection | undefined
    // An SSH-project node (`sshRemoteTmux`) runs its tmux on the remote host over the project's
    // ControlMaster (`sshRemote`); a plain ssh-terminal node (createSshTerminalNode) instead runs
    // `ssh` as a LOCAL pty program. Only the latter sets shell:'ssh' + buildSshArgs.
    const sshRemoteTmux = !!data.sshRemoteTmux
    const localSsh = !!ssh && !sshRemoteTmux
    // Prefetch the persisted scrollback in parallel with the spawn so it's ready to replay the
    // instant the session resolves (a cold restart after a reboot recreates the tmux session
    // empty — see the `fresh` handling below). Cheap no-op ('') when there's no snapshot.
    const scrollbackPromise = window.nodeTerminal.pty.readScrollback(id).catch(() => '')
    void (async () => {
      // SSH-project terminal: the project's live ControlMaster controlPath is established by
      // Canvas's active-project effect. On a cold app load child effects run before that parent
      // connect, so wait for it (briefly) before spawning. In Phase 1 a node only exists in the
      // active project's React Flow, so the active project is its owner.
      const sshRemote =
        sshRemoteTmux && ssh
          ? await resolveSshRemote(ssh, data.cwd as string | undefined)
          : undefined
      if (disposed) return
      transport
        .create({
          cols: term.cols,
          rows: term.rows,
          shell: localSsh ? 'ssh' : data.shell,
          shellArgs: localSsh ? buildSshArgs(ssh) : undefined,
          // Don't spawn a LOCAL tmux in a non-existent remote cwd if the master never came up.
          cwd: sshRemoteTmux && !sshRemote ? undefined : data.cwd,
          persistKey: id,
          agentId: data.agentId,
          sshRemote
        })
        .then(async ({ sessionId: sid, fresh }) => {
        if (disposed) {
          transport.kill(sid)
          return
        }
        sessionId = sid
        // Cold restart: the tmux session (and anything that was running in it) is gone — replay
        // the last persisted scrollback so the user sees where they left off. Warm reattach
        // (`fresh` false) skips this: tmux redraws the live screen itself, so replaying would
        // duplicate it. Skipped on the very first open too (`fresh` true but initialCommand set).
        if (fresh && !data.initialCommand) {
          const snapshot = await scrollbackPromise
          if (disposed) {
            transport.kill(sid)
            return
          }
          if (snapshot) {
            term.write(snapshot)
            term.write('\r\n\x1b[90m── session restored (process ended by a restart) ──\x1b[0m\r\n')
          }
        }
        // Flow control: track xterm's unprocessed write backlog (bytes handed to
        // term.write but not yet parsed). Past a high watermark we pause the source so
        // a flood can't grow this buffer without bound; we resume once it drains.
        let pending = 0
        let paused = false
        const HIGH_WATER = 1 << 20 // 1 MB
        const LOW_WATER = 1 << 18 //  256 KB
        cleanups.push(
          transport.onData(sid, (chunk) => {
            pending += chunk.length
            if (!paused && pending > HIGH_WATER) {
              paused = true
              transport.setFlow(sid, false)
            }
            term.write(chunk, () => {
              pending -= chunk.length
              if (paused && pending < LOW_WATER) {
                paused = false
                transport.setFlow(sid, true)
              }
            })
          })
        )
        cleanups.push(
          transport.onExit(sid, (code) => {
            term.write(`\r\n\x1b[90m[process exited with code ${code}]\x1b[0m\r\n`)
          })
        )
        cleanups.push(term.onData((input) => transport.write(sid, input)).dispose)
        // Run a one-shot command on first open (e.g. "gh auth login" or the agent CLI), then
        // forget it.
        if (data.initialCommand) {
          transport.write(sid, `${data.initialCommand}\n`)
          updateNodeData(id, { initialCommand: undefined })
        } else if (fresh && agentId && canResume(agentId)) {
          // Cold restart of an agent node: the live agent is gone, so re-launch it. Resume the
          // prior conversation by its session id (known from hooks) when we have one; otherwise
          // start the agent fresh. Plain terminals get nothing here — just the restored shell.
          const priorId = useAgentStatus.getState().byId[id]?.sessionId
          const cmd = (priorId && resumeCommand(agentId, priorId)) || agentConfig(agentId)?.launchCmd
          if (cmd) transport.write(sid, `${cmd}\n`)
        }
      })
    })()

    const resize = () => {
      try {
        fit.fit()
        if (sessionId) transport.resize(sessionId, term.cols, term.rows)
      } catch {
        // fit can throw when the size is 0 (e.g. collapsed); ignore.
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)

    return () => {
      disposed = true
      observer.disconnect()
      if (dwellRef.current) clearTimeout(dwellRef.current)
      cleanups.forEach((fn) => fn())
      useAgentStatus.getState().setActive(id, false)
      // Unmount happens on a project switch (a detach — the tmux session keeps running) as
      // well as on real deletion, and we can't tell them apart here. Don't wipe the node's
      // persisted status (that would drop the sessionId the context meter looks up on remount,
      // making the meter vanish when you switch projects); only clear the live state. Real
      // deletion drops the entry in Canvas.deleteNodes.
      useAgentStatus.getState().setState(id, undefined)
      useAgentNodes.getState().clearForParent(id)
      if (sessionId) transport.kill(sessionId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
      searchAddonRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.respawnNonce])

  // Live-apply font/cursor settings to the running terminal.
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontSize = fontSize
    term.options.fontFamily = fontFamily
    term.options.cursorBlink = cursorBlink
    try {
      fitRef.current?.fit()
    } catch {
      // ignore
    }
  }, [fontSize, fontFamily, cursorBlink])

  const toggleCollapse = () =>
    setNodes((ns) =>
      ns.map((n) => {
        if (n.id !== id) return n
        const next = !n.data.collapsed
        const expandedHeight =
          (n.data.expandedHeight as number) ?? n.measured?.height ?? (n.height as number) ?? 300
        const height = next ? COLLAPSED_HEIGHT : expandedHeight
        return {
          ...n,
          height,
          style: { ...n.style, height },
          data: { ...n.data, collapsed: next, expandedHeight }
        }
      })
    )

  // ---- hover guard: dwell before entering the terminal ----
  const onBodyEnter = () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    const enter = () => {
      // While Cmd/Ctrl is held the user is zooming the canvas — don't grab focus / enter the
      // terminal; just keep checking until the modifier is released.
      if (isZoomModifierHeld()) {
        dwellRef.current = setTimeout(enter, 200)
        return
      }
      setArmed(false)
      termRef.current?.focus()
      useAgentStatus.getState().setActive(id, true)
      useAgentStatus.getState().clearUnread(id)
    }
    dwellRef.current = setTimeout(enter, panHoverDelay)
  }
  const onBodyLeave = () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    setArmed(true)
    termRef.current?.blur()
    useAgentStatus.getState().setActive(id, false)
  }
  // While armed, a mousedown might start a node drag — pause the dwell timer so the
  // terminal doesn't grab focus mid-drag; restart it on release.
  const onGuardDown = () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
  }

  // ---- file drop: paste dropped file paths into the terminal (native-terminal behavior) ----
  const onBodyDragOver = (e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    if (!dropping) setDropping(true)
  }
  const onBodyDragLeave = (e: React.DragEvent) => {
    const rt = e.relatedTarget as Node | null
    if (!rt || !(e.currentTarget as HTMLElement).contains(rt)) setDropping(false)
  }
  const onBodyDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files)
    setDropping(false)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    const term = termRef.current
    if (!term) return

    let paths: string[]
    if (data.sshRemoteTmux) {
      // Remote terminal: a local path is useless on the remote host. Upload each file over the
      // project's ControlMaster and paste the REMOTE absolute path instead. Fail-open: skip nulls.
      const projectId = useProjects.getState().activeProjectId
      const uploaded = await Promise.all(
        files.map((f) => {
          const lp = window.nodeTerminal.getPathForFile(f)
          return lp ? window.nodeTerminal.sshProject.uploadFile(projectId, lp, f.name) : Promise.resolve(null)
        })
      )
      paths = uploaded.filter((p): p is string => !!p).map(escapeDroppedPath)
    } else {
      paths = files
        .map((f) => window.nodeTerminal.getPathForFile(f))
        .filter(Boolean)
        .map(escapeDroppedPath)
    }
    if (!paths.length) return
    // Enter the terminal and paste the path(s) like a real drop (trailing space to continue).
    if (dwellRef.current) clearTimeout(dwellRef.current)
    setArmed(false)
    term.focus()
    term.paste(paths.join(' ') + ' ')
    useAgentStatus.getState().setActive(id, true)
  }

  // A rename-capable agent's session name follows the node title: push `/rename <name>` into
  // the live session (tmux send-keys, like Branch's /branch). No-op for other agents/shells.
  const pushSessionRename = (name: string) => {
    if (canRenameNode && name) void window.nodeTerminal.pty.sendText(id, `/rename ${name}`)
  }

  // The user took over the name (manual rename or ✦ AI-name): stop auto-tracking the session
  // and, for rename-capable agents, push the chosen name back to the session.
  const applyManualTitle = (raw: string) => {
    const name = raw.trim()
    updateNodeData(id, { title: name, titleAuto: false })
    pushSessionRename(name)
  }

  // Close the rename box, committing only if the value actually changed (so just clicking in
  // and out doesn't take ownership or fire a spurious /rename).
  const commitTitleEdit = (value: string) => {
    setEditingTitle(false)
    if (value.trim() !== titleEditStartRef.current.trim()) applyManualTitle(value)
  }

  const nameWithAi = async () => {
    setNaming(true)
    const r = await window.nodeTerminal.pty.generateName(id, (data.cwd as string) ?? '')
    setNaming(false)
    if (r.ok) applyManualTitle(r.message)
  }

  // Selecting a node clears its unread badge.
  useEffect(() => {
    if (selected) useAgentStatus.getState().clearUnread(id)
  }, [selected, id])

  // Keep the node title in sync with the agent session's display name — the name shown in
  // `/resume`, read from the transcript (`/rename` name, else auto name). This is the authoritative
  // source: `/rename` doesn't update the OSC terminal title, so reading the transcript is the only
  // way the name shows up after a resume. Polls only while the title still auto-tracks the session
  // (titleAuto) and stops once the user renames by hand. Claude-only via canRenameNode.
  useEffect(() => {
    if (!canRenameNode || data.titleAuto === false) return
    const sid = status?.sessionId ?? ''
    const cwd = (data.cwd as string) ?? ''
    if (!sid && !cwd) return
    let cancelled = false
    const sync = async () => {
      if (!titleAutoRef.current || editingTitleRef.current) return
      const name = await window.nodeTerminal.pty.readSessionName(sid, cwd)
      if (
        !cancelled &&
        name &&
        titleAutoRef.current &&
        !editingTitleRef.current &&
        name !== titleRef.current
      ) {
        updateNodeData(id, { title: name })
      }
    }
    void sync()
    const timer = setInterval(() => void sync(), 4000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [id, canRenameNode, status?.sessionId, data.cwd, data.titleAuto, updateNodeData])

  // Cmd/Ctrl+M toggles markdown view of this terminal's output (only when hovered).
  useEffect(() => {
    return window.nodeTerminal.onMarkdownToggle(() => {
      if (hoveredRef.current) updateNodeData(id, (n) => ({ mdMode: !n.data.mdMode }))
    })
  }, [id, updateNodeData])

  // Best-effort: highlight matches that are in the live xterm buffer (on-screen scrollback).
  useEffect(() => {
    const sa = searchAddonRef.current
    if (!sa) return
    if (!searchOpen || !search.query.trim()) {
      sa.clearDecorations()
      return
    }
    sa.findNext(search.query, findOpts)
  }, [search.query, searchOpen])

  // Cmd/Ctrl+F toggles the find-bar while this node is hovered. No main-process interception
  // needed (the Electron renderer has no native find UI), unlike Cmd+M.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'f' && hoveredRef.current) {
        e.preventDefault()
        setSearchOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // When markdown mode turns on, capture the terminal output and render it. Skipped when the
  // chat panel is active (it loads its own structured transcript), but still runs as the
  // fallback when a chat-capable node has no sessionId yet.
  useEffect(() => {
    if (data.mdMode && !useChat) {
      // Full scrollback (not just the visible viewport) so the whole session renders.
      void window.nodeTerminal.pty.capture(id, true).then((t) => setMdHtml(renderMarkdown(t)))
    }
  }, [data.mdMode, id, useChat])

  // Unread = the agent finished (not still working/waiting/blocked) while you weren't looking.
  // Drives both the header badge and a node-wide glow so it's obvious at a glance.
  const isUnread =
    !!status?.unread &&
    status?.state !== 'working' &&
    status?.state !== 'waiting' &&
    status?.state !== 'blocked'

  return (
    <div
      className={`term-node${selected ? ' selected' : ''}${collapsed ? ' collapsed' : ''}${
        isUnread ? ' unread' : ''
      }`}
      style={{ borderTopColor: data.color }}
      onMouseEnter={() => (hoveredRef.current = true)}
      onMouseLeave={() => (hoveredRef.current = false)}
    >
      <NodeResizer minWidth={260} minHeight={160} isVisible={selected && !collapsed} color="#0a84ff" />
      {/* Invisible source handle so edges to subagent/loop nodes can attach. */}
      <Handle
        id="flow-out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', bottom: 0 }}
      />
      {/* Context-link handles (context-link-capable nodes only): drag right→left to link two
          sessions. Vertically centered on the side edges; raised above the body so they're never buried. */}
      {showLink && (
        <>
          <Handle
            id="link-out"
            type="source"
            position={Position.Right}
            className="bridge-handle bridge-handle--out"
            data-tip="Link out — drag to another Claude node so they can read each other's context"
          />
          <Handle
            id="link-in"
            type="target"
            position={Position.Left}
            className="bridge-handle bridge-handle--in"
            data-tip="Link in — drop a link here to share context with this Claude session"
          />
        </>
      )}

      <div className="term-node__header">
        <button className="term-node__collapse" title={collapsed ? 'Expand' : 'Collapse'} onClick={toggleCollapse}>
          {collapsed ? '▸' : '▾'}
        </button>
        <button
          className="term-node__color"
          style={{ background: data.color }}
          title="Color"
          onClick={() => setShowColors((v) => !v)}
        />
        {showColors && (
          <div className="color-popover">
            {NODE_COLORS.map((c) => (
              <button
                key={c}
                style={{ background: c }}
                onClick={() => {
                  updateNodeData(id, { color: c })
                  setShowColors(false)
                }}
              />
            ))}
          </div>
        )}
        {editingTitle ? (
          <input
            className="term-node__title nodrag"
            value={data.title}
            spellCheck={false}
            autoFocus
            onChange={(e) => updateNodeData(id, { title: e.target.value })}
            // Enter commits, Escape reverts to the value editing started with. The blur that
            // follows either keypress is skipped (skipBlurRef) so we don't commit twice; a plain
            // focus-loss blur still commits.
            onBlur={(e) => {
              if (skipBlurRef.current) {
                skipBlurRef.current = false
                return
              }
              commitTitleEdit(e.currentTarget.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                skipBlurRef.current = true
                commitTitleEdit(e.currentTarget.value)
              } else if (e.key === 'Escape') {
                skipBlurRef.current = true
                updateNodeData(id, { title: titleEditStartRef.current })
                setEditingTitle(false)
              }
            }}
          />
        ) : (
          <span
            className="term-node__title-text nodrag"
            title="Click to rename"
            onClick={() => {
              titleEditStartRef.current = data.title as string
              setEditingTitle(true)
            }}
          >
            {data.title || 'Untitled'}
          </span>
        )}
        {status?.session && status.session !== data.title && (
          <span className="term-node__session" title={status.session}>
            {status.session}
          </span>
        )}
        {data.ssh ? (
          <span
            className="term-ssh-chip"
            title={`ssh ${(data.ssh as SshConnection).user}@${(data.ssh as SshConnection).host}`}
          >
            SSH {(data.ssh as SshConnection).user}@{(data.ssh as SshConnection).host}
          </span>
        ) : null}
        {showUsage && <ContextMeter sessionId={status?.sessionId ?? null} />}
        {status?.state === 'working' && (
          <span className="term-node__status term-node__status--busy" title={`${agentLabel} is working`}>
            <span className="term-node__status-dot" />
            RUNNING
          </span>
        )}
        {showLoop && status?.loop && (
          <span
            className="term-node__status term-node__status--loop"
            title={`Running /${status.loop.kind}`}
          >
            <span className="term-node__status-dot" />
            {status.loop.kind.toUpperCase()}
            {status.loop.count > 0 ? ` ×${status.loop.count}` : ''}
          </span>
        )}
        {(status?.state === 'waiting' || status?.state === 'blocked') && (
          <span
            className="term-node__status term-node__status--attention"
            title={`${agentLabel} needs your input`}
          >
            <span className="term-node__status-dot" />
            NEEDS YOU
          </span>
        )}
        {isUnread && (
            <span
              className="term-node__status term-node__status--unread"
              title="Finished — click to mark read"
            >
              <span className="term-node__status-dot" />
              unread
            </span>
          )}
        {!editingTitle && <span className="term-node__spacer" />}
        {canMoveIntoWorktree && (
          <Tooltip label="Move this terminal into the group's worktree">
            <button
              className="term-node__move-worktree nodrag"
              onClick={() => moveIntoWorktreeHandler?.(id)}
            >
              ↪
            </button>
          </Tooltip>
        )}
        <Tooltip label={showUsage ? 'Search terminal + conversation' : 'Search this terminal'}>
          <button
            className="term-node__search nodrag"
            onClick={() => setSearchOpen((v) => !v)}
            aria-pressed={searchOpen}
          >
            <IconSearch />
          </button>
        </Tooltip>
        <Tooltip label="Name with AI (from terminal output)">
          <button className="term-node__ai nodrag" disabled={naming} onClick={nameWithAi}>
            {naming ? '…' : '✦'}
          </button>
        </Tooltip>
        <button
          className="term-node__close"
          title="Close (ends the session)"
          onClick={() => {
            const remoteConn = (data.remote as { connectionId: string } | undefined)?.connectionId
            if (remoteConn) {
              // Remote node: no local tmux to destroy; tear down the relay connection
              // (socket + keepalive + main-process map entry). N:1, so this owns it.
              void window.nodeTerminal.remoteClient.disconnect(remoteConn)
            } else {
              transport.destroy(id)
            }
            deleteElements({ nodes: [{ id }] })
          }}
        >
          ×
        </button>
      </div>

      {searchOpen && !collapsed && (
        <FindBar
          query={search.query}
          onQueryChange={search.setQuery}
          matchIndex={search.matchIndex}
          matchCount={search.matchCount}
          current={search.current}
          onNext={handleNext}
          onPrev={handlePrev}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {!collapsed && (
        <NodeTags tags={tags} onChange={(t) => updateNodeData(id, { tags: t })} />
      )}

      {/* Body always mounted (keeps xterm alive); hidden via CSS when collapsed. */}
      <div
        className={`term-node__body${dropping ? ' dropping' : ''}`}
        onMouseEnter={onBodyEnter}
        onMouseLeave={onBodyLeave}
        onDragOver={onBodyDragOver}
        onDragLeave={onBodyDragLeave}
        onDrop={onBodyDrop}
      >
        <div className="term-node__xterm nodrag nowheel" ref={bodyRef} />
        {armed && !mdMode && (
          <div
            className="term-hover-guard"
            onMouseDown={onGuardDown}
            onMouseUp={onBodyEnter}
            title="Drag to move · scroll to pan · hover to focus"
          />
        )}
        {mdMode &&
          (useChat ? (
            <ChatPanel nodeId={id} sessionId={status?.sessionId} cwd={data.cwd as string | undefined} />
          ) : (
            <div className="term-md nodrag nowheel">
              <div className="term-md__bar">
                <span>Markdown</span>
                <span className="term-md__hint">⌘M to exit</span>
              </div>
              <div className="term-md__content" dangerouslySetInnerHTML={{ __html: mdHtml }} />
            </div>
          ))}
      </div>
    </div>
  )
}
