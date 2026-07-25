import { useEffect, useRef, useState } from 'react'
import { searchOrUrl } from './browserUrl'
import { BrowserStartPage } from './BrowserStartPage'
import { useBrowserHistory } from '../state/browserHistory'

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
  const lastUrlRef = useRef('')
  const [startUrl] = useState(() => url ?? '')
  const [src, setSrc] = useState(startUrl)
  const [address, setAddress] = useState(startUrl)
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [failed, setFailed] = useState('')

  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    const onStart = (): void => setLoading(true)
    const onStop = (): void => {
      setLoading(false)
      setCanBack(wv.canGoBack())
      setCanFwd(wv.canGoForward())
    }
    const onNav = (e: Event): void => {
      const u = (e as unknown as { url: string }).url
      setAddress(u)
      setFailed('')
      onUrlChange(u)
      lastUrlRef.current = u
      useBrowserHistory.getState().record(u, u)
    }
    const onNavInPage = (e: Event): void => setAddress((e as unknown as { url: string }).url)
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
  }, [onUrlChange, onTitleChange])

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
  }, [nodeId])

  // Keep the two webviews for one node (canvas + modal) in sync: when `url` changes from the
  // OUTSIDE (the other webview navigated → node.data.url updated) and differs from where we are,
  // follow it. Guarded on `!== address` so our own did-navigate (which sets address = url) is a
  // no-op — no reload loop.
  useEffect(() => {
    if (url && url !== address) {
      setSrc(url)
      setAddress(url)
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
    if (safe === src) ref.current?.reload()
    else setSrc(safe)
  }

  return (
    <div className="browser-surface">
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
        {/* eslint-disable-next-line react/no-unknown-property */}
        <webview
          ref={ref as unknown as React.Ref<HTMLElement>}
          src={src || undefined}
          allowpopups={true}
          style={{ width: '100%', height: '100%' }}
        />
        {!src && (
          <BrowserStartPage
            onNavigate={(u) => {
              setSrc(u)
              setAddress(u)
              setFailed('')
            }}
          />
        )}
        {failed && <div className="browser-node__error">{failed}</div>}
      </div>
    </div>
  )
}
