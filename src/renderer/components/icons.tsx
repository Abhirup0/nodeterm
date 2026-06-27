/** Small line icons (stroke = currentColor), shared across menus and the palette. */
const S = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

export const IconTerminal = () => (
  <svg {...S}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M7 9l3 3-3 3M13 15h4" />
  </svg>
)

export const IconNote = () => (
  <svg {...S}>
    <path d="M4 4h16v11l-5 5H4z" />
    <path d="M20 15h-5v5" />
  </svg>
)

export const IconDino = () => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="currentColor" stroke="none">
    {/* Blocky right-facing T-Rex silhouette (tail, body, head+snout, arm, legs). */}
    <rect x="3" y="11" width="6" height="3" />
    <rect x="8" y="9" width="11" height="7" />
    <rect x="14" y="3" width="7" height="7" />
    <rect x="21" y="7" width="2" height="2" />
    <rect x="18" y="12" width="2" height="3" />
    <rect x="9" y="16" width="2" height="5" />
    <rect x="14" y="16" width="2" height="5" />
  </svg>
)

export const IconPlus = () => (
  <svg {...S}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconSelectAll = () => (
  <svg {...S}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
  </svg>
)

export const IconFit = () => (
  <svg {...S}>
    <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />
  </svg>
)

export const IconColor = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="9" cy="10" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="15" cy="10" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="12" cy="15" r="1.2" fill="currentColor" stroke="none" />
  </svg>
)

export const IconGrid = () => (
  <svg {...S}>
    <path d="M4 9h16M4 15h16M9 4v16M15 4v16" />
  </svg>
)

export const IconCollapse = () => (
  <svg {...S}>
    <path d="M8 4v4H4M16 4v4h4M8 20v-4H4M16 20v-4h4" />
  </svg>
)

export const IconGroup = () => (
  <svg {...S}>
    <rect x="3" y="3" width="18" height="18" rx="2" strokeDasharray="3 3" />
    <rect x="7" y="7" width="4" height="4" rx="1" />
    <rect x="13" y="13" width="4" height="4" rx="1" />
  </svg>
)

export const IconUngroup = () => (
  <svg {...S}>
    <rect x="4" y="4" width="9" height="9" rx="1.5" />
    <rect x="12" y="12" width="8" height="8" rx="1.5" strokeDasharray="3 3" />
  </svg>
)

export const IconTrash = () => (
  <svg {...S}>
    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13h10l1-13" />
  </svg>
)

export const IconProject = () => (
  <svg {...S}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)

export const IconRemote = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18M12 3c2.5 2.5 2.5 15 0 18M12 3c-2.5 2.5-2.5 15 0 18" />
  </svg>
)

export const IconSwitch = () => (
  <svg {...S}>
    <path d="M7 7h11l-3-3M17 17H6l3 3" />
  </svg>
)

export const IconJump = () => (
  <svg {...S}>
    <circle cx="11" cy="11" r="7" />
    <path d="M11 8v6M8 11h6" />
  </svg>
)

export const IconSettings = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
  </svg>
)

export const IconBranch = () => (
  <svg {...S}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <circle cx="18" cy="8" r="2.5" />
    <path d="M6 8.5v7M6 13a6 6 0 0 0 6-6h3.5" />
  </svg>
)

export const IconEditor = () => (
  <svg {...S}>
    <path d="M9 8l-4 4 4 4M15 8l4 4-4 4" />
  </svg>
)

export const IconMarkdown = () => (
  <svg {...S}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="M6 15V9l3 3 3-3v6M16.5 9v5M14.5 12l2 2 2-2" />
  </svg>
)

export const IconDuplicate = () => (
  <svg {...S}>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </svg>
)

export const IconSave = () => (
  <svg {...S}>
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
    <path d="M17 21v-8H7v8M7 3v5h8" />
  </svg>
)

export const IconSearch = () => (
  <svg {...S}>
    <circle cx="11" cy="11" r="7" />
    <path d="M21 21l-4.35-4.35" />
  </svg>
)

export const IconSessions = () => (
  <svg {...S}>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <rect x="3" y="11" width="18" height="5" rx="1.5" />
    <line x1="6" y1="6.5" x2="6" y2="6.5" />
    <line x1="6" y1="13.5" x2="6" y2="13.5" />
  </svg>
)

export const IconPin = () => (
  <svg {...S}>
    <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6z" />
    <line x1="12" y1="14" x2="12" y2="21" />
  </svg>
)
