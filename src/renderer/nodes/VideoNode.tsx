import { useEffect, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'

/**
 * A video player node for a local video file. The file is served over the `nt-media://`
 * protocol (allowlisted on mount via `media.allow`) and rendered with native controls so
 * seeking/scrubbing works. The frame/header mirror {@link EditorNode} for consistent
 * drag/resize/close behavior.
 */
export default function VideoNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const filePath = (data.filePath as string) ?? ''
  const fileName = filePath.split('/').pop() || 'video'

  useEffect(() => {
    if (!filePath) return
    let alive = true
    window.nodeTerminal.media
      .allow(filePath)
      .then((url) => {
        if (alive) setSrc(url)
      })
      .catch(() => {
        if (alive) setError('Couldn’t load this video.')
      })
    return () => {
      alive = false
    }
  }, [filePath])

  return (
    <div
      className={`term-node video-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} color={data.color} />

      <div className="term-node__header">
        <span className="term-node__title-text" title={filePath}>
          {fileName}
        </span>
        <span className="term-node__spacer" />
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
            <video
              src={src}
              controls
              preload="metadata"
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
          ) : (
            <span className="editor-node__loading">{error || 'Loading…'}</span>
          )}
        </div>
      </div>
    </div>
  )
}
