import { cn } from './cn'

export function NumberField({
  value,
  onChange,
  min,
  max,
  step,
  className
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  className?: string
}): React.JSX.Element {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step}
      onChange={(e) => onChange(Number(e.target.value))}
      className={cn(
        'h-8 w-24 rounded-md border border-border bg-bg px-2.5 text-[13px] text-text outline-none focus:border-accent',
        className
      )}
    />
  )
}
