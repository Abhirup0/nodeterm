import type { SelectHTMLAttributes } from 'react'
import { cn } from './cn'

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      className={cn(
        'h-8 rounded-md border border-border bg-bg px-2 text-[13px] text-text outline-none focus:border-accent',
        className
      )}
      {...rest}
    >
      {children}
    </select>
  )
}
