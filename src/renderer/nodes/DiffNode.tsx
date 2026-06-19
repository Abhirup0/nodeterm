import { useEffect, useRef } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { monaco } from '../editor/monaco-setup'
import { useSettings } from '../state/settings'
import type { CanvasNode } from '../state/workspace'

/**
 * A Monaco diff editor node for a changed file. Staged diff = HEAD vs index;
 * unstaged diff = index vs working tree. Read-only.
 */
export function DiffNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const bodyRef = useRef<HTMLDivElement>(null)
  const cwd = (data.cwd as string) ?? ''
  const rel = (data.filePath as string) ?? ''
  const staged = !!data.diffStaged
  const commitOid = (data.commitOid as string | undefined) || ''

  useEffect(() => {
    const el = bodyRef.current
    if (!el || !cwd || !rel) return
    let disposed = false
    let editor: monaco.editor.IStandaloneDiffEditor | null = null
    let original: monaco.editor.ITextModel | null = null
    let modified: monaco.editor.ITextModel | null = null

    const git = window.nodeTerminal.git
    const abs = `${cwd}/${rel}`
    // commit mode: parent (<oid>^) vs commit (<oid>). staged: HEAD vs index. unstaged: index vs working.
    const origP = commitOid
      ? git.showFile(cwd, `${commitOid}^`, rel)
      : staged
        ? git.showFile(cwd, 'HEAD', rel)
        : git.showFile(cwd, '', rel)
    const modP = commitOid
      ? git.showFile(cwd, commitOid, rel)
      : staged
        ? git.showFile(cwd, '', rel)
        : window.nodeTerminal.fs.read(abs)

    Promise.all([origP, modP]).then(([orig, mod]) => {
      if (disposed) return
      const base = monaco.Uri.file(abs)
      const s = useSettings.getState().settings
      original = monaco.editor.createModel(orig, undefined, base.with({ fragment: `${id}-o` }))
      modified = monaco.editor.createModel(mod, undefined, base.with({ fragment: `${id}-m` }))
      editor = monaco.editor.createDiffEditor(el, {
        theme: 'vs-dark',
        readOnly: true,
        originalEditable: false,
        automaticLayout: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: s.fontSize,
        fontFamily: s.fontFamily
      })
      editor.setModel({ original, modified })
    })

    return () => {
      disposed = true
      editor?.dispose()
      original?.dispose()
      modified?.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      className={`term-node editor-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      <NodeResizer minWidth={420} minHeight={220} isVisible={selected} color={data.color} />

      <div className="term-node__header">
        <span className="term-node__title-text" title={`${rel} — ${commitOid ? commitOid.slice(0, 7) : staged ? 'staged' : 'working'}`}>
          {rel.split('/').pop()}
          <span className="diff-node__tag">{commitOid ? commitOid.slice(0, 7) : staged ? 'staged' : 'changes'}</span>
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

      <div className="editor-node__body nodrag nowheel" ref={bodyRef} />
    </div>
  )
}
