import { useEffect, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import { httpUrl } from './webUrl'

/**
 * A web view node. When `data.url` is set it loads that live URL; otherwise it serves the
 * local html at `data.filePath` over the `nt-media://` protocol (allowlisted on mount via
 * `media.allow`). Rendered in an Electron `<webview>` kept locked down (no `nodeintegration`).
 * The frame/header mirror {@link VideoNode}/EditorNode for consistent drag/resize/close behavior.
 */
export default function WebNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const url = (data.url as string) ?? ''
  const filePath = (data.filePath as string) ?? ''
  const title = (data.title as string) || url || filePath.split('/').pop() || 'web'

  useEffect(() => {
    let alive = true
    if (url) {
      const safe = httpUrl(url)
      if (safe) {
        setSrc(safe)
      } else {
        setError('Unsupported URL scheme — only http/https')
      }
    } else if (filePath) {
      window.nodeTerminal.media
        .allow(filePath)
        .then((mediaUrl) => {
          if (alive) setSrc(mediaUrl)
        })
        .catch(() => {
          if (alive) setError('Couldn’t load this page.')
        })
    }
    return () => {
      alive = false
    }
  }, [url, filePath])

  return (
    <div
      className={`term-node web-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} color={data.color} />
      {/* Invisible target handle so a rope from the agent node that opened this can attach. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />

      <div className="term-node__header">
        <span className="term-node__title-text" title={url || filePath}>
          {title}
        </span>
        <span className="term-node__spacer" />
        {url && (
          <button
            className="term-node__close"
            title="Open in browser"
            onClick={() => {
              const safe = httpUrl(url)
              if (safe) window.nodeTerminal.shell.openExternal(safe)
            }}
          >
            ↗
          </button>
        )}
        <button
          className="term-node__close"
          title="Close"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>

      <div className="editor-node__body">
        <div className="editor-node__image nodrag nowheel">
          {src ? (
            // eslint-disable-next-line react/no-unknown-property
            <webview src={src} style={{ width: '100%', height: '100%' }} />
          ) : (
            <span className="editor-node__loading">{error || 'No source'}</span>
          )}
        </div>
      </div>
    </div>
  )
}
