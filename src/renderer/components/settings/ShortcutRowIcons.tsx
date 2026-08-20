/** Small line-glyph icons for shortcut rows, in `SettingsIcons.tsx`'s shared-svg convention:
 *  16×16, currentColor stroke, color driven by the parent. */

function IconSvg({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** A keycap: rounded rect + center dot — the shortcut recorder's idle icon. */
export function IconRecordKey(): React.JSX.Element {
  return (
    <IconSvg>
      <rect x="2.5" y="3.5" width="11" height="9" rx="2" />
      <circle cx="8" cy="8" r="1" fill="currentColor" stroke="none" />
    </IconSvg>
  )
}

/** A small plus — add another binding. */
export function IconPlusSmall(): React.JSX.Element {
  return (
    <IconSvg>
      <path d="M8 3.5v9M3.5 8h9" />
    </IconSvg>
  )
}

/** A slash through a circle — disable this shortcut. */
export function IconDisableSlash(): React.JSX.Element {
  return (
    <IconSvg>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.7 11.3 11.3 4.7" />
    </IconSvg>
  )
}

/** A counter-clockwise rotate arrow with an arrowhead — reset to default. */
export function IconResetArrow(): React.JSX.Element {
  return (
    <IconSvg>
      <path d="M12.8 8A4.8 4.8 0 1 1 8 3.2" />
      <path d="M8 3.2H5M8 3.2v3" />
    </IconSvg>
  )
}
