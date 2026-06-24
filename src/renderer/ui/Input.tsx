import type { InputHTMLAttributes } from 'react'
import { cn } from './cn'

export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return (
    <input
      className={cn(
        'h-8 rounded-md border border-border bg-bg px-2.5 text-[13px] text-text outline-none placeholder:text-muted-2 focus:border-accent',
        className
      )}
      {...rest}
    />
  )
}
