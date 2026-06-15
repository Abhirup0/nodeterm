import { useEffect, useRef, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { renderMarkdown } from '../lib/markdown'
import { transport } from '../terminal/local-transport'
import { patchTerminalScale } from '../terminal/scale-fix'
import { NodeTags } from '../components/NodeTags'
import { Tooltip } from '../components/Tooltip'
import { useSettings } from '../state/settings'
import { COLLAPSED_HEIGHT, NODE_COLORS, type CanvasNode } from '../state/workspace'

/**
 * A single terminal node: header (collapse + color + title + close), optional tag chips,
 * and a real xterm.js terminal. A hover guard delays entering the terminal so the canvas
 * can be panned across terminals without grabbing focus. Cmd/Ctrl+M (while hovered)
 * toggles a markdown view of the terminal's output.
 */
export function TerminalNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements, getZoom, setNodes } = useReactFlow()
  const settings = useSettings((s) => s.settings)
  const bodyRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const dwellRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showColors, setShowColors] = useState(false)
  const [armed, setArmed] = useState(true)
  const [naming, setNaming] = useState(false)
  const [mdHtml, setMdHtml] = useState('')
  const [editingTitle, setEditingTitle] = useState(false)
  const hoveredRef = useRef(false)
  const mdMode = !!data.mdMode
  const collapsed = !!data.collapsed
  const tags = (data.tags as string[]) ?? []

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

    let sessionId: string | null = null
    let disposed = false
    const cleanups: Array<() => void> = []

    transport
      .create({ cols: term.cols, rows: term.rows, shell: data.shell, cwd: data.cwd, persistKey: id })
      .then((sid) => {
        if (disposed) {
          transport.kill(sid)
          return
        }
        sessionId = sid
        cleanups.push(transport.onData(sid, (chunk) => term.write(chunk)))
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
    term.options.fontSize = settings.fontSize
    term.options.fontFamily = settings.fontFamily
    term.options.cursorBlink = settings.cursorBlink
    try {
      fitRef.current?.fit()
    } catch {
      // ignore
    }
  }, [settings.fontSize, settings.fontFamily, settings.cursorBlink])

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
    }, settings.panHoverDelay)
  }
  const onBodyLeave = () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
    setArmed(true)
    termRef.current?.blur()
  }
  // While armed, a mousedown might start a node drag — pause the dwell timer so the
  // terminal doesn't grab focus mid-drag; restart it on release.
  const onGuardDown = () => {
    if (dwellRef.current) clearTimeout(dwellRef.current)
  }

  const nameWithAi = async () => {
    setNaming(true)
    const r = await window.nodeTerminal.pty.generateName(id, (data.cwd as string) ?? '')
    setNaming(false)
    if (r.ok) updateNodeData(id, { title: r.message })
  }

  // Cmd/Ctrl+M toggles markdown view of this terminal's output (only when hovered).
  useEffect(() => {
    return window.nodeTerminal.onMarkdownToggle(() => {
      if (hoveredRef.current) updateNodeData(id, (n) => ({ mdMode: !n.data.mdMode }))
    })
  }, [id, updateNodeData])

  // When markdown mode turns on, capture the terminal output and render it.
  useEffect(() => {
    if (data.mdMode) {
      void window.nodeTerminal.pty.capture(id).then((t) => setMdHtml(renderMarkdown(t)))
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
      <div className="term-node__body" onMouseEnter={onBodyEnter} onMouseLeave={onBodyLeave}>
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
