import { useEffect, useRef, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { transport } from '../terminal/local-transport'
import { NODE_COLORS, type TermNode } from '../state/workspace'

/**
 * A single terminal node: a header (title + color + close) with a real xterm.js
 * terminal inside. The terminal session (PTY) is opened through the transport when
 * the component mounts and closed when it unmounts.
 */
export function TerminalNode({ id, data, selected }: NodeProps<TermNode>) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const bodyRef = useRef<HTMLDivElement>(null)
  const [showColors, setShowColors] = useState(false)

  // Terminal lifecycle — set up exactly once.
  useEffect(() => {
    const container = bodyRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#11131a', foreground: '#c0caf5' },
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()

    let sessionId: string | null = null
    let disposed = false
    const cleanups: Array<() => void> = []

    transport
      .create({ cols: term.cols, rows: term.rows, shell: data.shell, cwd: data.cwd })
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
        // Forward user input to the PTY.
        cleanups.push(term.onData((input) => transport.write(sid, input)).dispose)
      })

    // Re-fit the terminal whenever the container size changes (resize/zoom layout).
    const resize = () => {
      try {
        fit.fit()
        if (sessionId) transport.resize(sessionId, term.cols, term.rows)
      } catch {
        // fit can throw when the size is 0; ignore.
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(container)

    return () => {
      disposed = true
      observer.disconnect()
      cleanups.forEach((fn) => fn())
      if (sessionId) transport.kill(sessionId)
      term.dispose()
    }
    // shell/cwd are only used at creation time; the empty dependency array is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className={`term-node${selected ? ' selected' : ''}`} style={{ borderTopColor: data.color }}>
      <NodeResizer minWidth={260} minHeight={160} isVisible={selected} color="#7aa2f7" />

      <div className="term-node__header">
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
        <input
          className="term-node__title nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        <button
          className="term-node__close"
          title="Close"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>

      {/* nodrag: clicking the terminal must not drag the node. nowheel: for scrollback. */}
      <div className="term-node__body nodrag nowheel" ref={bodyRef} />
    </div>
  )
}
