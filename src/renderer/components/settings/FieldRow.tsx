import type React from 'react'

/** label (+ optional description, + optional highlighted note) on the left, a control on the right. */
export function FieldRow({
  label,
  description,
  note,
  control,
  htmlFor
}: {
  label: string
  description?: string
  /** A caveat about the current value (e.g. "this setting can't take effect here") — same size as
   *  the description but in the warning accent, so it reads as a state, not as help text. */
  note?: string
  control: React.ReactNode
  htmlFor?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-text">
          {label}
        </label>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
        {note ? (
          <p className="mt-1 text-[12px] leading-relaxed text-[#ff9f0a]">{note}</p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}
