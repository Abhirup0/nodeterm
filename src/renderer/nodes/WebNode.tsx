import { useEffect, useRef, useState } from 'react'
import { Handle, NodeResizer, Position, useReactFlow, type NodeProps } from '@xyflow/react'
import type { CanvasNode } from '../state/workspace'
import { httpUrl } from './webUrl'
import { useSettings } from '../state/settings'
import { BROWSER_DISCARD_MS, shouldDiscard } from './browser-discard-policy'

/**
 * A web view node. When `data.url` is set it loads that live URL; otherwise it serves the
 * local html at `data.filePath` over the `nt-media://` protocol (allowlisted on mount via
 * `media.allow`). Rendered in an Electron `<webview>` kept locked down (no `nodeintegration`).
 * The frame/header mirror {@link VideoNode}/EditorNode for consistent drag/resize/close behavior.
 */
export default function WebNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { deleteElements } = useReactFlow()
  const [src, setSrc] = useState('')
  const [error, setError] = useState('')
  const url = (data.url as string) ?? ''
  const filePath = (data.filePath as string) ?? ''
  const title = (data.title as string) || url || filePath.split('/').pop() || 'web'
  const rootRef = useRef<HTMLDivElement | null>(null)
  // Memory saver — same policy as {@link BrowserSurface}: hidden long enough, the <webview> is
  // unmounted (its Chromium process exits) and rebuilt on reveal. `revive` is what re-runs the
  // source effect below, so the `nt-media://` grant is re-issued for a local file exactly as it
  // was at mount. Mutable inputs are refs because the observer is created once (see BrowserSurface).
  const [discarded, setDiscarded] = useState(false)
  const [revive, setRevive] = useState(0)
  const discardedRef = useRef(false)
  const hiddenSinceRef = useRef<number | null>(null)
  const srcRef = useRef('')
  /** "Loading" here is the media grant being in flight — the only await between mount and a
   *  usable src (a live URL is resolved synchronously). Discarding mid-grant would drop the
   *  answer to a request already made. */
  const grantingRef = useRef(false)

  useEffect(() => {
    let alive = true
    if (url) {
      const safe = httpUrl(url)
      if (safe) {
        setSrc(safe)
        srcRef.current = safe
      } else {
        setError('Unsupported URL scheme — only http/https')
      }
    } else if (filePath) {
      grantingRef.current = true
      window.nodeTerminal.media
        .allow(filePath)
        .then((mediaUrl) => {
          grantingRef.current = false
          if (alive) {
            setSrc(mediaUrl)
            srcRef.current = mediaUrl
          }
        })
        .catch(() => {
          grantingRef.current = false
          if (alive) setError('Couldn’t load this page.')
        })
    }
    return () => {
      alive = false
    }
  }, [url, filePath, revive])

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
      if (since == null || discardedRef.current || !srcRef.current) return
      const enabled = useSettings.getState().settings.browserMemorySaver
      if (!shouldDiscard({ hiddenMs: Date.now() - since, loading: grantingRef.current, enabled }))
        return
      discardedRef.current = true
      setDiscarded(true)
      setSrc('')
    }
    const obs = new IntersectionObserver((entries) => {
      const visible = entries[entries.length - 1]?.isIntersecting ?? true
      if (!visible) {
        if (hiddenSinceRef.current == null) hiddenSinceRef.current = Date.now()
        if (!timer) timer = setTimeout(fire, BROWSER_DISCARD_MS + 1000)
        return
      }
      hiddenSinceRef.current = null
      clear()
      if (!discardedRef.current) return
      discardedRef.current = false
      setDiscarded(false)
      setError('')
      setRevive((n) => n + 1)
    })
    obs.observe(el)
    return () => {
      obs.disconnect()
      clear()
    }
  }, [])

  return (
    <div
      ref={rootRef}
      className={`term-node web-node${selected ? ' selected' : ''}`}
      style={{ borderTopColor: data.color }}
    >
      <NodeResizer minWidth={320} minHeight={200} isVisible={selected} color={data.color} />
      {/* Invisible target handle so a rope from the agent node that opened this can attach. */}
      <Handle
        id="flow-in"
        type="target"
        position={Position.Top}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', top: 0 }}
      />

      <div className="term-node__header">
        <span className="term-node__title-text" title={url || filePath}>
          {title}
        </span>
        <span className="term-node__spacer" />
        {url && (
          <button
            className="term-node__close"
            title="Open in browser"
            onClick={() => {
              const safe = httpUrl(url)
              if (safe) window.nodeTerminal.shell.openExternal(safe)
            }}
          >
            ↗
          </button>
        )}
        <button
          className="term-node__close"
          title="Close"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>

      <div className="editor-node__body">
        <div className="editor-node__image nodrag nowheel">
          {discarded ? (
            <div className="browser-node__discarded">
              <span>Page released to save memory — reopens on view</span>
            </div>
          ) : src ? (
            // eslint-disable-next-line react/no-unknown-property
            <webview src={src} style={{ width: '100%', height: '100%' }} />
          ) : (
            <span className="editor-node__loading">{error || 'No source'}</span>
          )}
        </div>
      </div>
    </div>
  )
}
