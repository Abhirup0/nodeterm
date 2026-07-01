import { useEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import { normalizeAddress } from './browserUrl'

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

/**
 * A navigable Chromium browser node (Electron <webview>) with a back/forward/reload + address
 * toolbar. Locked down (no nodeintegration); `allowpopups` is set only so main can capture
 * new-window requests and turn them into another browser node. The last top-level URL is
 * persisted to `data.url` so the node reopens where it was. The frame/header mirror
 * {@link WebNode}/VideoNode for consistent drag/resize/close behavior.
 */
export default function BrowserNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements, updateNodeData } = useReactFlow()
  const ref = useRef<WebviewEl | null>(null)
  // Seed the initial webview src ONCE at mount; navigations persist via updateNodeData but must
  // not re-push `src` into a webview that already navigated there (would cause a reload loop).
  const [startUrl] = useState(() => (data.url as string) ?? '')
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
      updateNodeData(id, { url: u }) // persist last top-level URL
    }
    const onNavInPage = (e: Event): void => setAddress((e as unknown as { url: string }).url)
    const onTitle = (e: Event): void =>
      updateNodeData(id, { title: (e as unknown as { title: string }).title })
    const onFail = (e: Event): void => {
      const ev = e as unknown as { isMainFrame: boolean; errorCode: number; errorDescription: string }
      // -3 (ABORTED) fires on user-initiated stop / redirect races — ignore it.
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
  }, [id, updateNodeData])

  // Register the guest's webContents id → node id so main can turn its new-window (target=_blank
  // / window.open) requests into another connected browser node. Paired unregister on unmount.
  useEffect(() => {
    const wv = ref.current
    if (!wv) return
    let wcId = 0
    const onReady = (): void => {
      wcId = wv.getWebContentsId()
      window.nodeTerminal.browser.register(wcId, id)
    }
    wv.addEventListener('dom-ready', onReady)
    return () => {
      wv.removeEventListener('dom-ready', onReady)
      if (wcId) window.nodeTerminal.browser.unregister(wcId)
    }
  }, [id])

  const go = (): void => {
    const safe = normalizeAddress(address)
    if (!safe) {
      setFailed('Enter a valid http(s) URL')
      return
    }
    setAddress(safe)
    setFailed('')
    ref.current?.loadURL(safe)
  }

  return (
    <div
      className={`term-node browser-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      <NodeResizer minWidth={360} minHeight={240} isVisible={selected} color={data.color} />
      {/* Invisible target handle so a rope from the agent node that opened this can attach. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />
      {/* Invisible source handle so a rope to a browser node this one spawned (new-window) attaches. */}
      <Handle
        id="flow-out"
        type="source"
        position={Position.Bottom}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', bottom: 0 }}
      />

      <div className="term-node__header">
        <span className="term-node__title-text" title={address}>
          {(data.title as string) || 'Browser'}
        </span>
        <span className="term-node__spacer" />
        <button
          className="term-node__close"
          title="Close"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>

      <div className="browser-node__toolbar nodrag">
        <button
          className="browser-node__btn"
          disabled={!canBack}
          onClick={() => ref.current?.goBack()}
          title="Back"
        >
          ◀
        </button>
        <button
          className="browser-node__btn"
          disabled={!canFwd}
          onClick={() => ref.current?.goForward()}
          title="Forward"
        >
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

      <div className="editor-node__body">
        <div className="browser-node__view nodrag nowheel">
          {/* eslint-disable-next-line react/no-unknown-property */}
          <webview
            ref={ref as unknown as React.Ref<HTMLElement>}
            src={startUrl || undefined}
            // React types `allowpopups` as a boolean (@types/react WebViewHTMLAttributes);
            // rendered as the `allowpopups` attribute Electron reads. No `nodeintegration`.
            allowpopups={true}
            style={{ width: '100%', height: '100%' }}
          />
          {failed && <div className="browser-node__error">{failed}</div>}
        </div>
      </div>
    </div>
  )
}
