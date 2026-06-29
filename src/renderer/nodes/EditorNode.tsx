import { useEffect, useRef, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { monaco } from '../editor/monaco-setup'
import { renderMarkdown } from '../lib/markdown'
import { useSettings } from '../state/settings'
import { remoteFs } from '../terminal/remote-fs'
import { sshFs } from '../terminal/ssh-fs'
import { useProjects } from '../state/projects'
import type { CanvasNode } from '../state/workspace'

// Image extensions get a visual preview instead of the Monaco text editor.
const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/**
 * A code editor node backed by Monaco. Reads the file on mount, auto-detects the language
 * from the path, and saves back with ⌘S (or the Save button). Image files are shown as a
 * preview instead of being opened as (binary) text.
 */
export function EditorNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const bodyRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const savedRef = useRef<string>('')
  const hoveredRef = useRef(false)
  const [dirty, setDirty] = useState(false)
  const [preview, setPreview] = useState(false)
  const [previewHtml, setPreviewHtml] = useState('')
  const [imageSrc, setImageSrc] = useState('')
  const [imageDims, setImageDims] = useState('')
  const [imageError, setImageError] = useState('')
  const filePath = (data.filePath as string) ?? ''
  // Backend pick (the `FsApi` shape is identical across all three, so the rest of the component is
  // unchanged): a relay session operates on the HOST's filesystem via the relay; an SSH-project
  // editor (`data.sshFs`) on the project's remote fs over the ControlMaster; otherwise the local fs.
  const activeProjectId = useProjects((s) => s.activeProjectId)
  const connectionId = data.remote?.connectionId
  const fs = connectionId
    ? remoteFs(connectionId)
    : data.sshFs && activeProjectId
      ? sshFs(activeProjectId)
      : window.nodeTerminal.fs
  const fileName = filePath.split('/').pop() || 'untitled'
  const ext = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  const isImage = ext in IMAGE_MIME

  const togglePreview = () => {
    if (isImage) return
    setPreview((p) => {
      const next = !p
      if (next && editorRef.current) setPreviewHtml(renderMarkdown(editorRef.current.getValue()))
      return next
    })
  }
  const toggleRef = useRef(togglePreview)
  toggleRef.current = togglePreview

  const save = () => {
    const editor = editorRef.current
    if (!editor) return
    const value = editor.getValue()
    fs.write(filePath, value).then((ok) => {
      if (ok) {
        savedRef.current = value
        setDirty(false)
      }
    })
  }
  const saveRef = useRef(save)
  saveRef.current = save

  useEffect(() => {
    if (!filePath) return

    // Images: load as a data URL and render an <img> preview (no Monaco).
    if (isImage) {
      let disposed = false
      // Guard: readBinary may be missing if the preload is stale (dev not restarted).
      const readBinary = fs.readBinary
      if (typeof readBinary !== 'function') {
        setImageError('Image preview needs an app restart.')
        return
      }
      readBinary(filePath)
        .then((b64) => {
          if (disposed) return
          if (b64) setImageSrc(`data:${IMAGE_MIME[ext]};base64,${b64}`)
          else setImageError('Couldn’t read this image.')
        })
        .catch(() => {
          if (!disposed) setImageError('Couldn’t read this image.')
        })
      return () => {
        disposed = true
      }
    }

    const el = bodyRef.current
    if (!el) return
    let disposed = false
    let editor: monaco.editor.IStandaloneCodeEditor | null = null
    let model: monaco.editor.ITextModel | null = null

    fs.read(filePath).then((content) => {
      if (disposed) return
      const s = useSettings.getState().settings
      // Unique model per node (fragment), language still inferred from the path extension.
      const uri = monaco.Uri.file(filePath).with({ fragment: id })
      model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(content, undefined, uri)
      editor = monaco.editor.create(el, {
        model,
        theme: 'vs-dark',
        fontSize: s.fontSize,
        fontFamily: s.fontFamily,
        minimap: { enabled: false },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        tabSize: 2
      })
      editorRef.current = editor
      savedRef.current = content
      editor.onDidChangeModelContent(() => setDirty(editor!.getValue() !== savedRef.current))
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
    })

    return () => {
      disposed = true
      editor?.dispose()
      model?.dispose()
      editorRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Cmd/Ctrl+M toggles a rendered markdown preview when this node is hovered.
  useEffect(() => window.nodeTerminal.onMarkdownToggle(() => {
    if (hoveredRef.current) toggleRef.current()
  }), [])

  return (
    <div
      className={`term-node editor-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
      onMouseEnter={() => (hoveredRef.current = true)}
      onMouseLeave={() => (hoveredRef.current = false)}
    >
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} color={data.color} />

      <div className="term-node__header">
        <span className="term-node__title-text" title={filePath}>
          {fileName}
          {!isImage && dirty ? ' ●' : ''}
        </span>
        <span className="term-node__spacer" />
        {isImage ? (
          imageDims && <span className="editor-node__dims">{imageDims}</span>
        ) : (
          <>
            <button
              className="editor-node__toggle"
              title="Toggle markdown preview (⌘M)"
              onClick={togglePreview}
            >
              {preview ? 'Edit' : 'Preview'}
            </button>
            <button
              className="editor-node__save"
              disabled={!dirty}
              title="Save (⌘S)"
              onClick={save}
            >
              Save
            </button>
          </>
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
        {isImage ? (
          <div className="editor-node__image nodrag nowheel">
            {imageSrc ? (
              <img
                src={imageSrc}
                alt={fileName}
                onLoad={(e) => {
                  const img = e.currentTarget
                  if (img.naturalWidth) setImageDims(`${img.naturalWidth} × ${img.naturalHeight}`)
                }}
              />
            ) : (
              <span className="editor-node__loading">{imageError || 'Loading…'}</span>
            )}
          </div>
        ) : (
          <>
            <div className="editor-node__monaco nodrag nowheel" ref={bodyRef} />
            {preview && (
              <div className="term-md nodrag nowheel">
                <div className="term-md__bar">
                  <span>Preview</span>
                  <span className="term-md__hint">⌘M to edit</span>
                </div>
                <div
                  className="term-md__content"
                  dangerouslySetInnerHTML={{ __html: previewHtml }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
