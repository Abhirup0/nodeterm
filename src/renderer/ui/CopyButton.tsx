import { useEffect, useRef, useState, type ButtonHTMLAttributes } from 'react'
import { Button } from './Button'

type Variant = 'default' | 'primary' | 'ghost'

/**
 * Copy-to-clipboard button with transient "Copied!" feedback. Defaults to the primary variant
 * so the action reads clearly and has an obvious hover state. The label flips to "Copied!" for
 * ~1.5s after a click, then reverts.
 */
export function CopyButton({
  text,
  label = 'Copy',
  variant = 'primary',
  ...rest
}: {
  text: string
  label?: string
  variant?: Variant
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'>): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => () => clearTimeout(timer.current), [])

  return (
    <Button
      variant={variant}
      onClick={() => {
        window.nodeTerminal.clipboard.writeText(text)
        setCopied(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(false), 1500)
      }}
      {...rest}
    >
      {copied ? 'Copied!' : label}
    </Button>
  )
}
