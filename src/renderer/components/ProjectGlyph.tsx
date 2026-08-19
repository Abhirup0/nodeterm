import type { ProjectIcon } from '@shared/project-icon'

export interface ProjectGlyphProps {
  /** The project's icon, when it has one. Absent → render the site's pre-icon fallback. */
  icon?: ProjectIcon
  /** The project's own color — tints the lucide placeholder and drives both fallbacks. Optional
   *  so a caller can suppress the fallback tint entirely (TabBar's inactive-tab dot only colors
   *  the active tab; passing `undefined` there reproduces that exactly). */
  color?: string
  /** Project display name — the monogram fallback's first initial, and the image's empty alt. */
  name: string
  /** Content sizing (emoji font-size). Fallback/icon box size comes from `className`'s own CSS,
   *  same as every render site did before this component existed — this only sizes the glyph
   *  drawn inside that box. */
  size?: number
  /** Fallback shape when `icon` is absent: a plain colored dot, or a colored circle with the
   *  name's first initial. Default 'monogram' — the more common site. */
  variant?: 'dot' | 'monogram'
  /** The render site's own class — keeps that site's existing box size/position CSS in charge, so
   *  swapping in `ProjectGlyph` doesn't move or resize anything when `icon` is absent. */
  className?: string
  title?: string
}

const DEFAULT_SIZE = 16

/**
 * TODO(Task 4): lucide-react is not yet a dependency of this package — Task 4 adds it, plus the
 * real curated map (`Record<string, LucideIcon>` built from `LUCIDE_ICON_IDS`, one import per
 * icon so unused ones tree-shake out). Until then a lucide icon renders as this tinted, bordered
 * placeholder so the branch is exercised (by tests and by real data) without blocking Task 2 on
 * the new dependency. Task 4's swap-in point is exactly here: replace `LucidePlaceholder`'s body
 * (or the call site below) with `const Icon = LUCIDE_ICONS[icon.name]; <Icon color={color} .../>`
 * and delete this function — no other call site in this file needs to change.
 */
function LucidePlaceholder({ color }: { color?: string }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="100%" height="100%" aria-hidden="true" data-testid="lucide-placeholder">
      <rect
        x="2.5"
        y="2.5"
        width="11"
        height="11"
        rx="3"
        fill="none"
        stroke={color || 'currentColor'}
        strokeWidth="1.5"
      />
    </svg>
  )
}

/**
 * A project's small badge, used wherever the UI shows one beside a project's name: its custom
 * icon when it has one (emoji, a curated lucide glyph, or an image — GitHub avatar/upload/
 * favicon), else the fallback that render site already showed before project icons existed — a
 * plain colored dot or a colored-circle monogram of the name's first letter. Every wired call
 * site passes its own `className`, so an absent `icon` reproduces that site's pre-icon markup
 * exactly: same element, same class, same conditional style.
 */
export function ProjectGlyph({
  icon,
  color,
  name,
  size = DEFAULT_SIZE,
  variant = 'monogram',
  className,
  title
}: ProjectGlyphProps): JSX.Element {
  if (icon?.type === 'emoji') {
    return (
      <span
        className={className}
        title={title}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: Math.round(size * 0.8),
          lineHeight: 1
        }}
      >
        {icon.emoji}
      </span>
    )
  }

  if (icon?.type === 'lucide') {
    return (
      <span
        className={className}
        title={title}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <LucidePlaceholder color={color} />
      </span>
    )
  }

  if (icon?.type === 'image') {
    return (
      <span className={className} title={title} style={{ display: 'inline-flex', overflow: 'hidden' }}>
        <img src={icon.src} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </span>
    )
  }

  if (variant === 'dot') {
    return <span className={className} style={color ? { background: color } : undefined} title={title} />
  }

  return (
    <span className={className} style={{ background: color }} title={title}>
      {(name.trim() || '?').charAt(0).toUpperCase()}
    </span>
  )
}
