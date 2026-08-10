import { useEffect, useRef, useState } from 'react'
import { searchOrUrl } from './browserUrl'
import { BrowserStartPage } from './BrowserStartPage'
import { useBrowserHistory } from '../state/browserHistory'
import { useDiscardWhenHidden } from './useDiscardWhenHidden'
import { DiscardedPlate } from './DiscardedPlate'

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
  // Memory saver (see `useDiscardWhenHidden`): the page is released while hidden and rebuilt on
  // reveal. `loadingRef` mirrors the `loading` state because the hook reads it at fire time, from
  // a callback that must not force the observer to be re-created.
  const [discarded, setDiscarded] = useState(false)
  const loadingRef = useRef(false)
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
  // canvas caps nothing. The state machine (observer, timer, fire-time re-checks) lives in the
  // shared hook; this surface contributes only what "loading"/"content" mean for it and how to
  // release and rebuild its page.
  useDiscardWhenHidden(rootRef, {
    isLoading: () => loadingRef.current,
    hasContent: () => !!locationRef.current,
    onDiscard: () => {
      setDiscarded(true)
      setSrc('')
      // A failure banner belongs to the page we just released; the restore re-navigates and will
      // raise its own if the load fails again.
      setFailed('')
    },
    onRestore: () => {
      setDiscarded(false)
      // Restore from the descriptor. Setting `src` and `address` to the SAME value preserves the
      // `url !== address` guard of the sync effect below, so the restore can't start a reload loop.
      const back = locationRef.current
      setSrc(back)
      setAddress(back)
    }
  })

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
        {discarded && <DiscardedPlate />}
        {failed && <div className="browser-node__error">{failed}</div>}
      </div>
    </div>
  )
}
