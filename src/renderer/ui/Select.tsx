import type { SelectHTMLAttributes } from 'react'
import { cn } from './cn'

export function Select({
  className,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <span className="relative inline-flex items-center">
      <select
        className={cn(
          'h-8 rounded-md border border-border bg-bg pl-2.5 pr-7 text-[13px] text-text outline-none focus:border-accent',
          className
        )}
        {...rest}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute right-2 text-muted-2"
        width="12"
        height="12"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 4.5 6 7.5l3-3" />
      </svg>
    </span>
  )
}
