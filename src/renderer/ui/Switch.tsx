import { cn } from './cn'

export function Switch({
  checked,
  onChange,
  ariaLabel
}: {
  checked: boolean
  onChange: (v: boolean) => void
  ariaLabel?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative box-border block h-[24px] w-[42px] shrink-0 cursor-pointer rounded-full border-0 p-0 outline-none transition-colors duration-200',
        checked ? 'bg-accent' : 'bg-white/15'
      )}
    >
      <span
        className={cn(
          'absolute left-[3px] top-[3px] size-[18px] rounded-full bg-white shadow-sm transition-transform duration-200',
          checked ? 'translate-x-[18px]' : 'translate-x-0'
        )}
      />
    </button>
  )
}
