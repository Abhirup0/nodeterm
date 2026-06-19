export function SegmentedPill<T extends string>({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <div className="seg-pill" role="radiogroup" aria-label={ariaLabel}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          role="radio"
          aria-checked={opt.value === value}
          className={`seg-pill-opt${opt.value === value ? ' active' : ''}`}
          onClick={() => {
            if (opt.value !== value) onChange(opt.value)
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
