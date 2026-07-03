export interface Shortcut {
  label: string
  url: string
}

export const SHORTCUTS: Shortcut[] = [
  { label: 'Google', url: 'https://www.google.com' },
  { label: 'YouTube', url: 'https://www.youtube.com' },
  { label: 'GitHub', url: 'https://github.com' },
  { label: 'Gmail', url: 'https://mail.google.com' },
  { label: 'X', url: 'https://x.com' },
  { label: 'ChatGPT', url: 'https://chatgpt.com' },
  { label: 'Reddit', url: 'https://www.reddit.com' },
  { label: 'Wikipedia', url: 'https://www.wikipedia.org' }
]

function hostKey(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// Self-contained inline brand marks (no external fetch), keyed by hostname. Sites not listed
// here fall back to a colored monogram — trivial to add more marks later.
const ICONS: Record<string, JSX.Element> = {
  'github.com': (
    <svg viewBox="0 0 16 16" width="58%" height="58%" fill="#fff" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  ),
  'youtube.com': (
    <svg viewBox="0 0 24 24" width="72%" height="72%" aria-hidden="true">
      <rect x="1" y="5" width="22" height="14" rx="4" fill="#FF0000" />
      <path d="M10 8.5l6 3.5-6 3.5z" fill="#fff" />
    </svg>
  ),
  'x.com': (
    <svg viewBox="0 0 24 24" width="52%" height="52%" fill="#fff" aria-hidden="true">
      <path d="M18.9 2h3.3l-7.2 8.3L23.5 22h-6.6l-5.2-6.8L5.7 22H2.4l7.7-8.8L1.5 2h6.8l4.7 6.2L18.9 2zM17.7 20h1.8L7.1 4H5.1L17.7 20z" />
    </svg>
  ),
  'reddit.com': (
    <svg viewBox="0 0 24 24" width="76%" height="76%" aria-hidden="true">
      <circle cx="12" cy="13" r="9" fill="#FF4500" />
      <circle cx="8.6" cy="13" r="1.4" fill="#fff" />
      <circle cx="15.4" cy="13" r="1.4" fill="#fff" />
      <path d="M8.7 16.2c1.1.9 5.5.9 6.6 0" stroke="#fff" strokeWidth="1.1" fill="none" strokeLinecap="round" />
    </svg>
  )
}

const MONO_COLORS = ['#4285F4', '#EA4335', '#34A853', '#F9AB00', '#a259ff', '#ff6d00', '#00b8d4', '#e91e63']
function monoColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return MONO_COLORS[h % MONO_COLORS.length]
}

/** A site's brand mark (inline SVG) when known, else a colored monogram tile. */
export function SiteIcon({ url, label, size = 44 }: { url: string; label?: string; size?: number }): JSX.Element {
  const key = hostKey(url)
  const svg = ICONS[key]
  const seed = key || label || '?'
  const letter = (label || key || '?').charAt(0).toUpperCase()
  return (
    <span
      className="site-icon"
      style={{
        width: size,
        height: size,
        background: svg ? 'rgba(255,255,255,0.06)' : monoColor(seed)
      }}
    >
      {svg ?? <span className="site-icon__letter">{letter}</span>}
    </span>
  )
}
