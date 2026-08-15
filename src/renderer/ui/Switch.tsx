import { cn } from './cn'

export function Switch({
  checked,
  onChange,
  ariaLabel,
  disabled = false
}: {
  checked: boolean
  onChange: (v: boolean) => void
  ariaLabel?: string
  /** Renders inert (native `disabled` + aria): for a switch whose subject does not currently
   *  exist, e.g. a per-project capability while no project is open. */
  disabled?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative box-border block h-[24px] w-[42px] shrink-0 rounded-full border-0 p-0 outline-none transition-colors duration-200',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        checked ? 'bg-accent' : 'bg-fill'
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
