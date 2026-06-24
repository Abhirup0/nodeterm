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
    <div className="flex items-center justify-between gap-6">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-text">
          {label}
        </label>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  )
}
