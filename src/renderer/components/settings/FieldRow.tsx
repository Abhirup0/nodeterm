import type React from 'react'

/** label (+ optional description) on the left, a control on the right. */
export function FieldRow({
  label,
  description,
  control,
  htmlFor
}: {
  label: string
  description?: string
  control: React.ReactNode
  htmlFor?: string
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-[13px] text-text">
          {label}
        </label>
        {description ? <p className="mt-0.5 text-xs text-muted">{description}</p> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}
