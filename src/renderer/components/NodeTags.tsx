import { useState } from 'react'

interface NodeTagsProps {
  tags: string[]
  onChange: (tags: string[]) => void
}

/** Inline tag chips with add/remove, used inside nodes. */
export function NodeTags({ tags, onChange }: NodeTagsProps) {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')

  const commit = () => {
    const t = draft.trim()
    if (t && !tags.includes(t)) onChange([...tags, t])
    setDraft('')
    setAdding(false)
  }

  return (
    <div className="node-tags nodrag">
      {tags.map((t) => (
        <span key={t} className="node-tag">
          {t}
          <button title="Remove tag" onClick={() => onChange(tags.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="node-tag-input"
          value={draft}
          autoFocus
          spellCheck={false}
          placeholder="tag"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft('')
              setAdding(false)
            }
          }}
          onBlur={commit}
        />
      ) : (
        <button className="node-tag-add" title="Add tag" onClick={() => setAdding(true)}>
          + tag
        </button>
      )}
    </div>
  )
}
