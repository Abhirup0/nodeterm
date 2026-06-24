import type { ButtonHTMLAttributes } from 'react'
import { cn } from './cn'

type Variant = 'default' | 'primary' | 'ghost'

export function Button({
  variant = 'default',
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }): React.JSX.Element {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex cursor-pointer items-center justify-center rounded-md px-3 py-1.5 text-[13px] font-medium outline-none transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-white hover:bg-accent-hover',
        variant === 'ghost' && 'bg-transparent text-muted hover:text-text',
        variant === 'default' && 'border border-border bg-panel-header text-text hover:bg-[rgba(255,255,255,0.06)]',
        className
      )}
      {...rest}
    />
  )
}
