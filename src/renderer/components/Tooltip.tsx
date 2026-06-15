import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface TooltipProps {
  label: string
  children: ReactNode
  delay?: number
}

/** A custom styled tooltip (portal, fixed-positioned) shown on hover after a short delay. */
export function Tooltip({ label, children, delay = 350 }: TooltipProps) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const show = (e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const r = el.getBoundingClientRect()
      setPos({ x: r.left + r.width / 2, y: r.bottom + 6 })
    }, delay)
  }

  const hide = () => {
    if (timer.current) clearTimeout(timer.current)
    setPos(null)
  }

  return (
    <span className="tooltip-trigger nodrag" onMouseEnter={show} onMouseLeave={hide} onMouseDown={hide}>
      {children}
      {pos &&
        createPortal(
          <div className="tooltip" style={{ left: pos.x, top: pos.y }}>
            {label}
          </div>,
          document.body
        )}
    </span>
  )
}
