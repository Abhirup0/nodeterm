import { useEffect, useRef, useState } from 'react'
import {
  LUCIDE_ICON_IDS,
  sanitizeProjectIcon,
  type ProjectIcon
} from '@shared/project-icon'
import { cn } from '@renderer/ui/cn'
import { ProjectGlyph } from '../ProjectGlyph'
import EmojiPickerLazy from './EmojiPickerLazy'

/**
 * The project-icon picker: a live preview + Reset over four tabs (Avatar — a disabled stub Task 5
 * fills in — / Emoji / Lucide / Upload) plus the project's colour swatches. Every choice is run
 * through `sanitizeProjectIcon` before it leaves — the same boundary the stored value crosses on
 * load — so the picker can only ever emit a value the rest of the app will accept, and Reset emits
 * `undefined` (back to the colour monogram).
 *
 * The component is presentational: it owns only which tab is open and the upload error. Persistence
 * (setProjectIcon / setProjectColor + the workspace-dirty commit) lives in the caller via `onIcon`
 * / `onColor`, exactly like the identity rows around it.
 */
export interface ProjectIconPickerProps {
  projectId: string
  name: string
  icon?: ProjectIcon
  color?: string
  colors: readonly string[]
  /** App's resolved appearance — forced onto the emoji picker rather than its own auto. */
  dark: boolean
  onIcon: (icon: ProjectIcon | undefined) => void
  onColor: (color: string) => void
}

type Tab = 'avatar' | 'emoji' | 'lucide' | 'upload'

export function ProjectIconPicker({
  projectId,
  name,
  icon,
  color,
  colors,
  dark,
  onIcon,
  onColor
}: ProjectIconPickerProps): React.JSX.Element {
  // Default to a functional, non-lazy tab: never Emoji (that would pull the ~500 KB chunk the
  // moment the picker mounts, defeating the whole lazy split).
  const [tab, setTab] = useState<Tab>('lucide')
  const [uploadError, setUploadError] = useState<string | undefined>(undefined)
  // Whether this project resolves a GitHub avatar (origin + auth) — the Avatar tab shows only then.
  const [avatarAvailable, setAvatarAvailable] = useState(false)
  const [avatarError, setAvatarError] = useState<string | undefined>(undefined)

  const commit = (raw: ProjectIcon): void => onIcon(sanitizeProjectIcon(raw))

  // Latest icon/onIcon read from the open-time probe without making them effect deps (which would
  // re-fire the probe on every icon edit).
  const iconRef = useRef(icon)
  iconRef.current = icon
  const onIconRef = useRef(onIcon)
  onIconRef.current = onIcon

  const fetchAvatar = async (): Promise<{ dataUrl: string } | null> => {
    try {
      return (await window.nodeTerminal?.githubIssues?.projectAvatar(projectId)) ?? null
    } catch {
      return null
    }
  }

  // Lazy refresh, once per open (per project): probe the GitHub avatar. A non-null result means the
  // origin resolves → reveal the Avatar tab; if the stored icon is a github avatar whose bytes have
  // drifted, quietly re-commit the fresh src. ANTI-CLOBBER: a null/failed resolve touches nothing —
  // it must never blank an already-set github icon, and a no-origin project simply keeps the tab
  // hidden. Fires only here (mount / projectId change) — never on a timer or on every render.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await fetchAvatar()
      if (cancelled || !res) return
      setAvatarAvailable(true)
      const cur = iconRef.current
      if (cur?.type === 'image' && cur.source === 'github' && cur.src !== res.dataUrl) {
        onIconRef.current(sanitizeProjectIcon({ type: 'image', src: res.dataUrl, source: 'github' }))
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const onUseGithubAvatar = async (): Promise<void> => {
    setAvatarError(undefined)
    const res = await fetchAvatar()
    if (!res) {
      // Anti-clobber: leave the stored icon untouched on a failed resolve.
      setAvatarError('Could not fetch the GitHub avatar right now. Try again in a moment.')
      return
    }
    setAvatarAvailable(true)
    commit({ type: 'image', src: res.dataUrl, source: 'github' })
  }

  const hasGithubIcon = icon?.type === 'image' && icon.source === 'github'
  // Show the Avatar tab when the origin resolves, or when the project already wears a github avatar
  // (so a transient resolve failure never strands the user without the tab).
  const showAvatar = avatarAvailable || hasGithubIcon

  const TABS: { id: Tab; label: string; disabled?: boolean }[] = [
    { id: 'avatar', label: 'Avatar', disabled: !showAvatar },
    { id: 'emoji', label: 'Emoji' },
    { id: 'lucide', label: 'Lucide' },
    { id: 'upload', label: 'Upload' }
  ]

  const onUpload = async (): Promise<void> => {
    setUploadError(undefined)
    const res = await window.nodeTerminal.shell.pickProjectIcon()
    if (!res) return // cancelled
    if ('error' in res) {
      setUploadError(res.error)
      return
    }
    commit({ type: 'image', src: res.dataUrl, source: 'upload' })
  }

  return (
    <div className="flex flex-col gap-3" data-project-icon-picker={projectId}>
      {/* Preview + Reset */}
      <div className="flex items-center gap-3">
        <span
          className="flex size-11 items-center justify-center overflow-hidden rounded-xl bg-black/10 text-[18px] font-semibold text-white"
          aria-label="Current icon"
        >
          <ProjectGlyph icon={icon} color={color} name={name} size={28} />
        </span>
        <button
          type="button"
          className="rounded-lg border border-white/15 px-2.5 py-1 text-[13px] text-muted transition-colors hover:text-text disabled:opacity-40"
          onClick={() => {
            setUploadError(undefined)
            onIcon(undefined)
          }}
          disabled={!icon}
          aria-label="Remove icon"
        >
          Reset
        </button>
      </div>

      {/* Colour swatches — the accent for this project's tab and monogram. */}
      <div className="flex items-center gap-1.5" role="group" aria-label="Color">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            data-project-color={c}
            aria-label={`Color ${c}`}
            aria-pressed={color === c}
            style={{ background: c }}
            className={cn(
              'size-5 rounded-full border-0 outline-none transition-transform hover:scale-110',
              color === c && 'ring-2 ring-white/80 ring-offset-2 ring-offset-transparent'
            )}
            onClick={() => onColor(c)}
          />
        ))}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1" role="tablist" aria-label="Icon source">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            disabled={t.disabled}
            className={cn(
              'rounded-lg px-2.5 py-1 text-[13px] transition-colors disabled:opacity-40',
              tab === t.id ? 'bg-white/15 text-text' : 'text-muted hover:text-text'
            )}
            onClick={() => t.disabled || setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Panel */}
      <div className="rounded-xl border border-white/10 p-2" role="tabpanel">
        {tab === 'avatar' ? (
          <div className="flex flex-col gap-2 px-1 py-2">
            <button
              type="button"
              className="w-fit rounded-lg border border-white/15 px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-white/10"
              onClick={() => void onUseGithubAvatar()}
            >
              Use GitHub avatar
            </button>
            <p className="text-[12px] leading-relaxed text-muted">
              Uses the avatar of the GitHub owner this project&apos;s remote points to, shared with
              the repo like the name and colour. It refreshes each time you open this panel.
            </p>
            {avatarError ? (
              <p role="alert" className="text-[12px] text-[color:var(--warn)]">
                {avatarError}
              </p>
            ) : null}
          </div>
        ) : null}

        {tab === 'emoji' ? (
          <EmojiPickerLazy dark={dark} onEmoji={(emoji) => commit({ type: 'emoji', emoji })} />
        ) : null}

        {tab === 'lucide' ? (
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(2.25rem, 1fr))' }}
          >
            {LUCIDE_ICON_IDS.map((n) => {
              const selected = icon?.type === 'lucide' && icon.name === n
              return (
                <button
                  key={n}
                  type="button"
                  data-lucide-id={n}
                  aria-label={n}
                  aria-pressed={selected}
                  title={n}
                  className={cn(
                    'flex size-9 items-center justify-center rounded-lg text-muted transition-colors hover:bg-white/10 hover:text-text',
                    selected && 'bg-white/15 text-text'
                  )}
                  onClick={() => commit({ type: 'lucide', name: n })}
                >
                  <span className="flex size-5 items-center justify-center">
                    <ProjectGlyph icon={{ type: 'lucide', name: n }} color={color} name={name} size={20} />
                  </span>
                </button>
              )
            })}
          </div>
        ) : null}

        {tab === 'upload' ? (
          <div className="flex flex-col gap-2 px-1 py-2">
            <button
              type="button"
              className="w-fit rounded-lg border border-white/15 px-3 py-1.5 text-[13px] text-text transition-colors hover:bg-white/10"
              onClick={() => void onUpload()}
            >
              Choose image…
            </button>
            <p className="text-[12px] leading-relaxed text-muted">
              The image is resized and re-encoded as a small PNG, then shared with the repo like the
              name and colour.
            </p>
            {uploadError ? (
              <p role="alert" className="text-[12px] text-[color:var(--warn)]">
                {uploadError}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
