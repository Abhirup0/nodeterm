import { useEffect, useRef, useState } from 'react'
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
import { renderMarkdown } from '../lib/markdown'
import { transport } from '../terminal/local-transport'
import { patchTerminalScale } from '../terminal/scale-fix'
import { NodeTags } from '../components/NodeTags'
import { Tooltip } from '../components/Tooltip'
import { ContextMeter } from '../components/ContextMeter'
import { useSettings } from '../state/settings'
import { useAgentStatus } from '../state/agentStatus'
import { useAgentNodes } from '../state/agentNodes'
import { COLLAPSED_HEIGHT, NODE_COLORS, type CanvasNode } from '../state/workspace'

/** Backslash-escape shell-special characters, like a native terminal does on file drop. */
function escapeDroppedPath(p: string): string {
  return p.replace(/([ \t"'`\\()&;|<>$!*?[\]{}#~])/g, '\\$1')
}

/**
 * A single terminal node: header (collapse + color + title + close), optional tag chips,
 * and a real xterm.js terminal. A hover guard delays entering the terminal so the canvas
 * can be panned across terminals without grabbing focus. Cmd/Ctrl+M (while hovered)
 * toggles a markdown view of the terminal's output. Files dropped from Finder are pasted
 * as their (escaped) paths, like a native terminal — so Claude can read dropped images.
 */
export function TerminalNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, getZoom, setNodes } = useReactFlow()
  // Scoped selectors (not the whole settings object) so this node only re-renders when a
  // field it actually uses changes — not on every unrelated settings edit.
  const panHoverDelay = useSettings((s) => s.settings.panHoverDelay)
  const fontSize = useSettings((s) => s.settings.fontSize)
  const fontFamily = useSettings((s) => s.settings.fontFamily)
  const cursorBlink = useSettings((s) => s.settings.cursorBlink)
  const bodyRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showColors, setShowColors] = useState(false)
  const [armed, setArmed] = useState(true)
  const [dropping, setDropping] = useState(false)
  const [naming, setNaming] = useState(false)
  const [mdHtml, setMdHtml] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const hoveredRef = useRef(false)
  const mdMode = !!data.mdMode
  const collapsed = !!data.collapsed
  const tags = (data.tags as string[]) ?? []
  const isClaude = tags.includes('claude')
  const status = useAgentStatus((s) => s.byId[id])
  const updateNodeInternals = useUpdateNodeInternals()

  // The bridge handles are added/positioned dynamically for Claude nodes; make React Flow
  // re-measure them so edges anchor to the (centered) handle, not a stale position.
  useEffect(() => {
    if (isClaude) updateNodeInternals(id)
  }, [isClaude, id, updateNodeInternals])

  // Terminal lifecycle — set up exactly once.
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
    term.open(container)
    fit.fit()
    patchTerminalScale(term, getZoom)

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

    // Claude Code state (busy/idle/attention) comes from Claude's own hooks via the
    // claude:status IPC (handled centrally in Canvas) — not from parsing the output here.
    // We only surface the conversation topic from the terminal title, when Claude sets one.
    if (isClaude) {
      cleanups.push(
        term.onTitleChange((t) => {
          const title = t.trim()
          // Ignore path/prompt-like titles (e.g. "user@host: ~/dir") which aren't session names.
          if (title && !/[/:~]/.test(title)) useAgentStatus.getState().setSession(id, title)
        }).dispose
      )
    }

    transport
      .create({
        cols: term.cols,
        rows: term.rows,
        shell: data.shell,
        cwd: data.cwd,
        persistKey: id,
        agentId: data.agentId
      })
      .then((sid) => {
        if (disposed) {
          transport.kill(sid)
          return
        }
        sessionId = sid
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
        // Run a one-shot command on first open (e.g. "gh auth login"), then forget it.
        if (data.initialCommand) {
          transport.write(sid, `${data.initialCommand}\n`)
          updateNodeData(id, { initialCommand: undefined })
        }
      })

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
      useAgentStatus.getState().remove(id)
      useAgentNodes.getState().clearForParent(id)
      if (sessionId) transport.kill(sessionId)
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
    dwellRef.current = setTimeout(() => {
      setArmed(false)
      termRef.current?.focus()
      useAgentStatus.getState().setActive(id, true)
      useAgentStatus.getState().clearUnread(id)
    }, panHoverDelay)
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
  const onBodyDrop = (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files)
    setDropping(false)
    if (!files.length) return
    e.preventDefault()
    e.stopPropagation()
    const paths = files
      .map((f) => window.nodeTerminal.getPathForFile(f))
      .filter(Boolean)
      .map(escapeDroppedPath)
    if (!paths.length) return
    const term = termRef.current
    if (!term) return
    // Enter the terminal and paste the path(s) like a real drop (trailing space to continue).
    if (dwellRef.current) clearTimeout(dwellRef.current)
    setArmed(false)
    term.focus()
    term.paste(paths.join(' ') + ' ')
    useAgentStatus.getState().setActive(id, true)
  }

  const nameWithAi = async () => {
    setNaming(true)
    const r = await window.nodeTerminal.pty.generateName(id, (data.cwd as string) ?? '')
    setNaming(false)
    if (r.ok) updateNodeData(id, { title: r.message })
  }

  // Selecting a node clears its unread badge.
  useEffect(() => {
    if (selected) useAgentStatus.getState().clearUnread(id)
  }, [selected, id])

  // Cmd/Ctrl+M toggles markdown view of this terminal's output (only when hovered).
  useEffect(() => {
    return window.nodeTerminal.onMarkdownToggle(() => {
      if (hoveredRef.current) updateNodeData(id, (n) => ({ mdMode: !n.data.mdMode }))
    })
  }, [id, updateNodeData])

  // When markdown mode turns on, capture the terminal output and render it.
  useEffect(() => {
    if (data.mdMode) {
      // Full scrollback (not just the visible viewport) so the whole session renders.
      void window.nodeTerminal.pty.capture(id, true).then((t) => setMdHtml(renderMarkdown(t)))
    }
  }, [data.mdMode, id])

  return (
    <div
      className={`term-node${selected ? ' selected' : ''}${collapsed ? ' collapsed' : ''}`}
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
      {/* Bridge link handles (Claude nodes only): drag right→left to connect two sessions.
          Vertically centered on the side edges; raised above the body so they're never buried. */}
      {isClaude && (
        <>
          <Handle
            id="bridge-out"
            type="source"
            position={Position.Right}
            className="bridge-handle bridge-handle--out"
            data-tip="Bridge out — drag to another Claude node to link their sessions"
          />
          <Handle
            id="bridge-in"
            type="target"
            position={Position.Left}
            className="bridge-handle bridge-handle--in"
            data-tip="Bridge in — drop a link here to connect this Claude session"
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
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <span
            className="term-node__title-text nodrag"
            title="Click to rename"
            onClick={() => setEditingTitle(true)}
          >
            {data.title || 'Untitled'}
          </span>
        )}
        {status?.session && status.session !== data.title && (
          <span className="term-node__session" title={status.session}>
            {status.session}
          </span>
        )}
        {isClaude && <ContextMeter sessionId={status?.sessionId ?? null} />}
        {status?.state === 'working' && (
          <span className="term-node__status term-node__status--busy" title="Claude is working">
            <span className="term-node__status-dot" />
            RUNNING
          </span>
        )}
        {status?.loop && (
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
            title="Claude needs your input"
          >
            <span className="term-node__status-dot" />
            NEEDS YOU
          </span>
        )}
        {status?.unread &&
          status?.state !== 'working' &&
          status?.state !== 'waiting' &&
          status?.state !== 'blocked' && (
            <span
              className="term-node__status term-node__status--unread"
              title="Finished — click to mark read"
            >
              <span className="term-node__status-dot" />
              unread
            </span>
          )}
        {!editingTitle && <span className="term-node__spacer" />}
        <Tooltip label="Name with AI (from terminal output)">
          <button className="term-node__ai nodrag" disabled={naming} onClick={nameWithAi}>
            {naming ? '…' : '✦'}
          </button>
        </Tooltip>
        <button
          className="term-node__close"
          title="Close (ends the session)"
          onClick={() => {
            transport.destroy(id)
            deleteElements({ nodes: [{ id }] })
          }}
        >
          ×
        </button>
      </div>

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
        {mdMode && (
          <div className="term-md nodrag nowheel">
            <div className="term-md__bar">
              <span>Markdown</span>
              <span className="term-md__hint">⌘M to exit</span>
            </div>
            <div className="term-md__content" dangerouslySetInnerHTML={{ __html: mdHtml }} />
          </div>
        )}
      </div>
    </div>
  )
}
