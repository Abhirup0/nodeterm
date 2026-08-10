import { useEffect, useRef, useState } from 'react'
import { searchOrUrl } from './browserUrl'
import { BrowserStartPage } from './BrowserStartPage'
import { useBrowserHistory } from '../state/browserHistory'
import { useSettings } from '../state/settings'
import { BROWSER_DISCARD_MS, shouldDiscard } from './browser-discard-policy'

// Minimal typing for the Electron <webview> element methods/events we use.
type WebviewEl = HTMLElement & {
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  loadURL(url: string): void
  canGoBack(): boolean
  canGoForward(): boolean
  getWebContentsId(): number
}

interface BrowserSurfaceProps {
  /** The node id — registers the guest webContents so main can route its new-window requests. */
  nodeId: string
  /** Initial URL (seeded once at mount). */
  url: string
  /** Persist the top-level URL after a navigation. */
  onUrlChange: (url: string) => void
  /** Persist the page title. */
  onTitleChange: (title: string) => void
}

/**
 * The navigable Chromium surface (Electron <webview> + back/forward/reload + address bar), with
 * no node chrome. Shared by the canvas {@link BrowserNode} and the kanban card modal, so a browser
 * opens and navigates the same way on both. Navigation is driven by the `src` attribute (a src-less
 * webview never emits dom-ready, so imperative loadURL before then is a no-op); `did-navigate` only
 * updates the address, so in-page navigation can't loop.
 */
export function BrowserSurface({ nodeId, url, onUrlChange, onTitleChange }: BrowserSurfaceProps) {
  const ref = useRef<WebviewEl | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const lastUrlRef = useRef('')
  const [startUrl] = useState(() => url ?? '')
  const [src, setSrc] = useState(startUrl)
  const [address, setAddress] = useState(startUrl)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [failed, setFailed] = useState('')
  // Memory saver (see the discard effect): the page is released while hidden and rebuilt on
  // reveal. These four are REFS, not state, because the observer below is created once and must
  // read the CURRENT values without being torn down and re-armed on every state flip.
  const [discarded, setDiscarded] = useState(false)
  const discardedRef = useRef(false)
  const loadingRef = useRef(false)
  const hiddenSinceRef = useRef<number | null>(null)
  /** The page a discard would rebuild from — the last location we actually LOADED, never the
   *  address input (which holds whatever the user typed, submitted or not). */
  const locationRef = useRef(startUrl)

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const onStart = (): void => {
      loadingRef.current = true
      setLoading(true)
    }
    const onStop = (): void => {
      loadingRef.current = false
      setLoading(false)
      setCanBack(wv.canGoBack())
      setCanFwd(wv.canGoForward())
    }
    const onNav = (e: Event): void => {
      const u = (e as unknown as { url: string }).url
      setAddress(u)
      locationRef.current = u
      setFailed('')
      onUrlChange(u)
      lastUrlRef.current = u
      useBrowserHistory.getState().record(u, u)
    }
    const onNavInPage = (e: Event): void => {
      const u = (e as unknown as { url: string }).url
      setAddress(u)
      locationRef.current = u
    }
    const onTitle = (e: Event): void => {
      const title = (e as unknown as { title: string }).title
      onTitleChange(title)
      if (lastUrlRef.current) useBrowserHistory.getState().record(lastUrlRef.current, title)
    }
    const onFail = (e: Event): void => {
      const ev = e as unknown as { isMainFrame: boolean; errorCode: number; errorDescription: string }
      if (ev.isMainFrame && ev.errorCode !== -3) setFailed(ev.errorDescription || 'Failed to load')
    }
    wv.addEventListener('did-start-loading', onStart)
    wv.addEventListener('did-stop-loading', onStop)
    wv.addEventListener('did-navigate', onNav)
    wv.addEventListener('did-navigate-in-page', onNavInPage)
    wv.addEventListener('page-title-updated', onTitle)
    wv.addEventListener('did-fail-load', onFail)
    return () => {
      wv.removeEventListener('did-start-loading', onStart)
      wv.removeEventListener('did-stop-loading', onStop)
      wv.removeEventListener('did-navigate', onNav)
      wv.removeEventListener('did-navigate-in-page', onNavInPage)
      wv.removeEventListener('page-title-updated', onTitle)
      wv.removeEventListener('did-fail-load', onFail)
    }
    // `discarded` is a dep because a discard UNMOUNTS the <webview> element (dropping `src` alone
    // would leave the guest process alive): the restored element is a different node, so the
    // listeners have to be re-attached to it.
  }, [onUrlChange, onTitleChange, discarded])

  // Registers the guest so main can route its new-window requests. `discarded` is a dep for the
  // same reason as above — and it is what makes a discard UNREGISTER the dead wcId through this
  // cleanup, rather than leaking it until the node unmounts.
  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    let wcId = 0
    const onReady = (): void => {
      wcId = wv.getWebContentsId()
      window.nodeTerminal.browser.register(wcId, nodeId)
    }
    wv.addEventListener('dom-ready', onReady)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      if (wcId) window.nodeTerminal.browser.unregister(wcId)
    }
  }, [nodeId, discarded])

  // ── Memory saver ────────────────────────────────────────────────────────────────────────────
  // A browser node parked off-screen is a whole Chromium renderer process doing nothing, and the
  // canvas caps nothing. Hidden past the window (and not mid-load, and with the setting on) the
  // page is released; entering the viewport rebuilds it from `locationRef`.
  //
  // The observer is created ONCE. Putting `discarded`/`loading` in the deps would re-create it —
  // and IntersectionObserver re-reports on `observe()`, so the hidden timer would restart on every
  // state flip and a page could sit hidden forever without reaching the window. Everything mutable
  // is therefore read through a ref, and the SETTING is read at fire time (turning the saver off
  // must disarm a timer armed minutes earlier).
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let timer: ReturnType<typeof setTimeout> | null = null
    const clear = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
    }
    const fire = (): void => {
      timer = null
      const since = hiddenSinceRef.current
      if (since == null || discardedRef.current) return
      const enabled = useSettings.getState().settings.browserMemorySaver
      if (!shouldDiscard({ hiddenMs: Date.now() - since, loading: loadingRef.current, enabled }))
        return
      // A start page has no guest process to release, and discarding it would replace the one
      // useful thing on screen with a plate. (A page still loading after the whole window is not
      // re-checked either: v1 waits for the next hide, rather than polling.)
      if (!locationRef.current) return
      discardedRef.current = true
      setDiscarded(true)
      setSrc('')
      // A failure banner belongs to the page we just released; the restore re-navigates and will
      // raise its own if the load fails again.
      setFailed('')
    }
    const obs = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1]?.isIntersecting ?? true
      if (!visible) {
        if (hiddenSinceRef.current == null) hiddenSinceRef.current = Date.now()
        // +1s slack so the reading at fire time is strictly PAST the window (`shouldDiscard` is >).
        if (!timer) timer = setTimeout(fire, BROWSER_DISCARD_MS + 1000)
        return
      }
      hiddenSinceRef.current = null
      clear()
      if (!discardedRef.current) return
      discardedRef.current = false
      setDiscarded(false)
      // Restore from the descriptor. Setting `src` and `address` to the SAME value preserves the
      // `url !== address` guard of the sync effect below, so the restore can't start a reload loop.
      const back = locationRef.current
      setSrc(back)
      setAddress(back)
    })
    obs.observe(el)
    return () => {
      obs.disconnect()
      clear()
    }
  }, [])

  // Keep the two webviews for one node (canvas + modal) in sync: when `url` changes from the
  // OUTSIDE (the other webview navigated → node.data.url updated) and differs from where we are,
  // follow it. Guarded on `!== address` so our own did-navigate (which sets address = url) is a
  // no-op — no reload loop.
  useEffect(() => {
    if (url && url !== address) {
      setSrc(url)
      setAddress(url)
      // Keep the discard descriptor current even while discarded: a node released off-screen must
      // come back at where the OTHER webview navigated to, not at where it was released.
      locationRef.current = url
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  const go = (): void => {
    const safe = searchOrUrl(address)
    if (!safe) {
      setFailed('Enter a URL or search term')
      return
    }
    setAddress(safe)
    setFailed('')
    locationRef.current = safe
    if (safe === src) ref.current?.reload()
    else setSrc(safe)
  }

  return (
    <div className="browser-surface" ref={rootRef}>
      <div className="browser-node__toolbar nodrag">
        <button className="browser-node__btn" disabled={!canBack} onClick={() => ref.current?.goBack()} title="Back">
          ◀
        </button>
        <button className="browser-node__btn" disabled={!canFwd} onClick={() => ref.current?.goForward()} title="Forward">
          ▶
        </button>
        <button
          className="browser-node__btn"
          onClick={() => (loading ? ref.current?.stop() : ref.current?.reload())}
          title={loading ? 'Stop' : 'Reload'}
        >
          {loading ? '✕' : '⟳'}
        </button>
        <input
          className="browser-node__address"
          value={address}
          spellCheck={false}
          placeholder="Enter a URL and press Enter"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go()
          }}
        />
      </div>
      <div className="browser-node__view nodrag nowheel">
        {/* The element is UNMOUNTED while discarded — that is what ends the guest process; an
            emptied `src` attribute does not (Electron ignores a src mutation to nothing). */}
        {!discarded && (
          // eslint-disable-next-line react/no-unknown-property
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            src={src || undefined}
            allowpopups={true}
            style={{ width: '100%', height: '100%' }}
          />
        )}
        {!src && !discarded && (
          <BrowserStartPage
            onNavigate={(u) => {
              setSrc(u)
              setAddress(u)
              locationRef.current = u
              setFailed('')
            }}
          />
        )}
        {discarded && (
          <div className="browser-node__discarded">
            <span>Page released to save memory — reopens on view</span>
          </div>
        )}
        {failed && <div className="browser-node__error">{failed}</div>}
      </div>
    </div>
  )
}
