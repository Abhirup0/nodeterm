import { lazy, Suspense } from 'react'

/**
 * The emoji tab's picker, isolated behind `React.lazy` so `emoji-picker-react` (~500 KB) is a
 * dynamic chunk that loads ONLY when this component first renders — i.e. only when the user opens
 * the Emoji tab. ProjectIconPicker statically imports THIS wrapper (cheap), never the library, so
 * the heavy module stays out of the settings bundle until it is asked for. A test pins that: the
 * module's mock factory does not run until the Emoji tab is active.
 *
 * The library's props are typed loosely here on purpose — casting the lazy component avoids
 * importing anything from `emoji-picker-react` at module scope (even a type import can tempt a
 * bundler), and its `theme` accepts the plain strings its `Theme` enum resolves to at runtime.
 */
const EmojiPicker = lazy(() => import('emoji-picker-react')) as React.LazyExoticComponent<
  React.ComponentType<{
    autoFocusSearch?: boolean
    theme?: 'dark' | 'light' | 'auto'
    // The library's `EmojiStyle` enum resolves to these plain strings at runtime; typed loosely
    // here (like `theme`) to avoid importing the enum at module scope. 'native' renders OS glyphs.
    emojiStyle?: 'native' | 'apple' | 'twitter' | 'google' | 'facebook'
    lazyLoadEmojis?: boolean
    onEmojiClick?: (data: { emoji: string }) => void
    width?: string | number
    height?: string | number
  }>
>

export interface EmojiPickerLazyProps {
  /** Force the picker's palette to the app's resolved appearance rather than its own auto. */
  dark: boolean
  onEmoji: (emoji: string) => void
}

export default function EmojiPickerLazy({ dark, onEmoji }: EmojiPickerLazyProps): React.JSX.Element {
  return (
    <Suspense fallback={<div className="px-2 py-4 text-[13px] text-muted">Loading emoji…</div>}>
      <EmojiPicker
        autoFocusSearch={false}
        theme={dark ? 'dark' : 'light'}
        // Render OS-native emoji glyphs. The library defaults to EmojiStyle.APPLE, which emits every
        // emoji as an <img src="https://cdn.jsdelivr.net/…"> — blocked outright by the renderer CSP
        // (img-src 'self' data: nt-media:), so the whole grid would be broken images + blocked CDN
        // requests. 'native' (EmojiStyle.NATIVE) uses the font, offline-clean and CSP-safe.
        emojiStyle="native"
        lazyLoadEmojis
        width="100%"
        height={340}
        onEmojiClick={(data) => onEmoji(data.emoji)}
      />
    </Suspense>
  )
}
