import { useEffect, useRef, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { monaco } from '../editor/monaco-setup'
import { useSettings } from '../state/settings'
import type { CanvasNode } from '../state/workspace'

/**
 * A code editor node backed by Monaco. Reads the file on mount, auto-detects the language
 * from the path, and saves back with ⌘S (or the Save button).
 */
export function EditorNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const bodyRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const savedRef = useRef<string>('')
  const [dirty, setDirty] = useState(false)
  const filePath = (data.filePath as string) ?? ''
  const fileName = filePath.split('/').pop() || 'untitled'

  const save = () => {
    const editor = editorRef.current
    if (!editor) return
    const value = editor.getValue()
    window.nodeTerminal.fs.write(filePath, value).then((ok) => {
      if (ok) {
        savedRef.current = value
        setDirty(false)
      }
    })
  }
  const saveRef = useRef(save)
  saveRef.current = save

  useEffect(() => {
    const el = bodyRef.current
    if (!el || !filePath) return
    let disposed = false
    let editor: monaco.editor.IStandaloneCodeEditor | null = null
    let model: monaco.editor.ITextModel | null = null

    window.nodeTerminal.fs.read(filePath).then((content) => {
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

  return (
    <div
      className={`term-node editor-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} color={data.color} />

      <div className="term-node__header">
        <span className="term-node__title-text" title={filePath}>
          {fileName}
          {dirty ? ' ●' : ''}
        </span>
        <span className="term-node__spacer" />
        <button className="editor-node__save" disabled={!dirty} title="Save (⌘S)" onClick={save}>
          Save
        </button>
        <button
          className="term-node__close"
          title="Close"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>

      <div className="editor-node__body nodrag nowheel" ref={bodyRef} />
    </div>
  )
}
