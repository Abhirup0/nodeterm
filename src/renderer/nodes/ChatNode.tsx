// SDK-driven chat node: token-streaming conversation with Claude, permission cards,
// send-while-working queue. Continuity is resume-based via data.chatSessionId — the
// SDK process dies with the app; history reloads from the on-disk transcript.
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type Key
} from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { MarkdownText } from './ChatPanel'
import { useChatSessions } from '../state/chatSessions'
import { useAgentStatus } from '../state/agentStatus'
import { createDiffNode, type CanvasNode } from '../state/workspace'
import type { ChatImageAttachment, ChatToolSummary } from '@shared/types'

const MAX_IMAGES = 5
const MAX_IMAGE_BYTES = 2 * 1024 * 1024 // 2 MB per image

export default function ChatNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const chat = useChatSessions((s) => s.byId[id])
  const apply = useChatSessions((s) => s.apply)
  const seed = useChatSessions((s) => s.seed)
  const addLocalUser = useChatSessions((s) => s.addLocalUser)
  const clearError = useChatSessions((s) => s.clearError)
  const status = useAgentStatus((s) => s.byId[id])
  // The driver's agent-status event lands (IPC) before the store's first delta flips
  // chat.working, so OR both — this drives the badge, Stop button and typing indicator.
  const working = !!chat?.working || status?.state === 'working'
  const { setNodes, addNodes } = useReactFlow()
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ChatImageAttachment[]>([])
  const [attachNote, setAttachNote] = useState<string | null>(null)
  // Slash-command popup: an index into the filtered matches, plus a manual-dismiss flag
  // (Escape / after completion) so the popup can close without changing the input text.
  const [slashIdx, setSlashIdx] = useState(0)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const msgsRef = useRef<HTMLDivElement>(null)

  // Boot: subscribe to driver events, seed history from disk, start/reattach the driver.
  useEffect(() => {
    const off = window.nodeTerminal.chat.onEvent(id, (e) => {
      apply(id, e)
      if (e.kind === 'session') {
        // Persist the session id on the node so a relaunch resumes it.
        setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, chatSessionId: e.sessionId } } : n)))
      }
    })
    const own = data.chatSessionId as string | undefined
    const forkFrom = data.forkFrom as string | undefined
    // Fork path (Task 10): until our own session id arrives, resume the SOURCE session with
    // fork:true; once the driver's `session` event persists chatSessionId, forkFrom is ignored.
    const sessionId = own ?? forkFrom
    const accountId = data.accountId as string | undefined
    if (sessionId) void window.nodeTerminal.chat.readTranscript(sessionId, data.cwd as string | undefined, accountId).then((m) => seed(id, m))
    void window.nodeTerminal.chat.ensure(id, {
      cwd: data.cwd as string | undefined,
      sessionId,
      fork: !own && !!forkFrom ? true : undefined,
      accountId
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Fork bootstrap: forkFrom carries the source session id until our own id arrives.
  // (ensure() above passes fork:true with sessionId=data.forkFrom when set — see Task 10.)

  useEffect(() => {
    const el = msgsRef.current
    if (el) el.scrollTop = el.scrollHeight
    // `working` (not chat.working): the typing indicator is shown off the agent-status event,
    // which arrives before any delta touches the store — scroll must follow it too. toolOrder/
    // permission keep new tool cards and the permission card in view.
  }, [chat?.messages, chat?.streamText, chat?.streamThinking, working, chat?.toolOrder, chat?.permission])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text && images.length === 0) return
    window.nodeTerminal.chat.send(id, text, images.length ? images : undefined)
    if (!chat?.working) addLocalUser(id, text)
    setInput('')
    setImages([])
    setAttachNote(null)
    setSlashDismissed(false)
  }, [input, images, id, chat?.working, addLocalUser])

  // --- Image attachments (paste + drag-drop) -------------------------------
  const addFiles = useCallback(
    (files: File[]) => {
      const imgs = files.filter((f) => f.type.startsWith('image/'))
      if (imgs.length === 0) return
      let dropped = imgs.length - imgs.filter((f) => f.size <= MAX_IMAGE_BYTES).length // oversized
      const ok = imgs.filter((f) => f.size <= MAX_IMAGE_BYTES)
      Promise.all(
        ok.map(
          (f) =>
            new Promise<ChatImageAttachment>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => {
                const res = String(reader.result)
                // strip the `data:<mime>;base64,` prefix → raw base64
                const comma = res.indexOf(',')
                resolve({ mediaType: f.type, data: comma >= 0 ? res.slice(comma + 1) : res })
              }
              reader.onerror = () => reject(reader.error)
              reader.readAsDataURL(f)
            })
        )
      ).then((atts) => {
        setImages((prev) => {
          const room = Math.max(0, MAX_IMAGES - prev.length)
          const accepted = atts.slice(0, room)
          dropped += atts.length - accepted.length // over the 5-image cap
          return accepted.length ? [...prev, ...accepted] : prev
        })
        setAttachNote(dropped > 0 ? `Skipped ${dropped} file(s) — max ${MAX_IMAGES} images, 2 MB each` : null)
      })
    },
    []
  )

  const removeImage = (i: number) => setImages((prev) => prev.filter((_, idx) => idx !== i))

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault() // don't also paste the image path/text
      addFiles(files)
    }
  }
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    if (files.length) {
      e.preventDefault()
      addFiles(files)
    }
  }
  const onDragOver = (e: DragEvent<HTMLTextAreaElement>) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
  }

  // --- Slash-command popup -------------------------------------------------
  const trimmed = input.trim()
  const slashMatches = trimmed.startsWith('/')
    ? (chat?.slashCommands ?? []).filter((c) => c.startsWith(trimmed)).slice(0, 8)
    : []
  const slashOpen = slashMatches.length > 0 && !slashDismissed
  const slashActive = slashOpen ? Math.min(slashIdx, slashMatches.length - 1) : -1

  const completeSlash = (cmd: string) => {
    setInput(cmd + ' ')
    setSlashDismissed(true) // programmatic setInput doesn't re-open the popup
    setSlashIdx(0)
  }

  const onInputChange = (value: string) => {
    setInput(value)
    setSlashIdx(0)
    setSlashDismissed(false)
  }

  // --- Diff-preview tool card ----------------------------------------------
  const openDiff = (filePath?: string) => {
    const cwd = data.cwd as string | undefined
    if (!filePath || !cwd || !filePath.startsWith(cwd)) return
    const rel = filePath.slice(cwd.length).replace(/^\//, '')
    if (!rel) return
    addNodes(createDiffNode(0, cwd, rel, false)) // false → unstaged (working ↔ index)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx((i) => (i + 1) % slashMatches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length)
        return
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault()
        completeSlash(slashMatches[slashActive])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlashDismissed(true)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const perm = chat?.permission
  const cwd = data.cwd as string | undefined

  // Shared tool-card renderer for both live (toolOrder) and committed (folded into history at
  // turn-done) tools, so both get the same summary label + diff-preview click treatment.
  const renderTool = (
    t: { name: string; arg: string; result?: string; summary?: ChatToolSummary },
    key: Key,
    open: boolean
  ) => {
    const diffPath = t.summary?.filePath
    const canDiff = !!diffPath && !!cwd && diffPath.startsWith(cwd)
    return (
      <details key={key} className="term-chat__tool" open={open}>
        <summary>
          <span className="term-chat__tool-name">{t.name}</span>
          <span
            className={`term-chat__tool-arg${canDiff ? ' term-chat__tool-arg--link' : ''}`}
            title={canDiff ? 'Open diff' : undefined}
            onClick={
              canDiff
                ? (e) => {
                    e.preventDefault() // don't toggle the <details>
                    e.stopPropagation()
                    openDiff(diffPath)
                  }
                : undefined
            }
          >
            {t.summary ? `${t.summary.filePath} +${t.summary.added} −${t.summary.removed}` : t.arg}
          </span>
        </summary>
        {t.result && <pre className="term-chat__tool-result">{t.result}</pre>}
      </details>
    )
  }

  return (
    <div className={`chat-node${selected ? ' selected' : ''}`} style={{ borderTopColor: data.color }}>
      <NodeResizer isVisible={selected} minWidth={360} minHeight={280} />
      <div className="chat-node__header">
        <span className="chat-node__title">{(data.title as string) || 'Chat'}</span>
        {working && <span className="chat-node__badge chat-node__badge--working">RUNNING</span>}
        {perm && <span className="chat-node__badge chat-node__badge--needs">NEEDS YOU</span>}
        {/* Cost chip intentionally hidden: the SDK reports an API-equivalent estimate even on
            subscription auth, which reads as a real charge. costUsd still accumulates in the
            store — re-enable here once auth-aware display (or a settings toggle) exists. */}
      </div>
      <div className="chat-node__msgs nodrag nowheel" ref={msgsRef}>
        {chat?.messages.map((m, i) => (
          <div key={i} className={`term-chat__msg term-chat__msg--${m.role}`}>
            {m.parts.map((p, j) =>
              p.kind === 'text' ? (
                <MarkdownText key={j} text={p.text} />
              ) : p.kind === 'thinking' ? (
                <details key={j} className="chat-node__thinking"><summary>Thinking</summary><MarkdownText text={p.text} /></details>
              ) : (
                renderTool(p, j, false)
              )
            )}
          </div>
        ))}
        {/* Pre-stream gap: Enter → first SDK event has a noticeable latency (process/network).
            Show a pulsing typing indicator until anything from the turn arrives. */}
        {working &&
          !chat?.streamText &&
          !chat?.streamThinking &&
          (chat?.toolOrder.length ?? 0) === 0 && (
            <div className="chat-node__typing" aria-label="Claude is thinking">
              <span /><span /><span />
            </div>
          )}
        {/* Live turn: streaming thinking + text + tool cards */}
        {chat?.streamThinking && (
          <details className="chat-node__thinking"><summary>Thinking…</summary><MarkdownText text={chat.streamThinking} /></details>
        )}
        {chat?.toolOrder.map((tid) => renderTool(chat.tools[tid], tid, !chat.tools[tid].result))}
        {chat?.streamText && <div className="term-chat__msg term-chat__msg--assistant"><MarkdownText text={chat.streamText} /></div>}
        {/* Non-fatal errors: a dismissible inline line. Fatal errors get the reconnect bar
            in place of the compose box (below). */}
        {chat?.error && !chat.error.fatal && (
          <div className="chat-node__error">
            <span>{chat.error.message}</span>
            <button className="chat-node__error-dismiss" title="Dismiss" onClick={() => clearError(id)}>×</button>
          </div>
        )}
        {perm && (
          <div className="chat-node__permission">
            <div className="chat-node__permission-title">Allow {perm.toolName}?</div>
            <pre className="chat-node__permission-input">{JSON.stringify(perm.input, null, 2).slice(0, 600)}</pre>
            <div className="chat-node__permission-actions">
              <button onClick={() => window.nodeTerminal.chat.permissionReply(id, perm.requestId, { behavior: 'allow' })}>Allow</button>
              <button onClick={() => window.nodeTerminal.chat.permissionReply(id, perm.requestId, { behavior: 'allow', alwaysSession: true })}>Always (session)</button>
              <button onClick={() => window.nodeTerminal.chat.permissionReply(id, perm.requestId, { behavior: 'deny' })}>Deny</button>
            </div>
          </div>
        )}
      </div>
      {chat && chat.queue.length > 0 && (
        <div className="chat-node__queue">
          {chat.queue.map((q) => (
            <span key={q.id} className="chat-node__queue-item">
              {q.text.slice(0, 40)}
              <button onClick={() => window.nodeTerminal.chat.removeQueued(id, q.id)}>×</button>
            </span>
          ))}
        </div>
      )}
      {(images.length > 0 || attachNote) && (
        <div className="chat-node__attach nodrag">
          {images.map((img, i) => (
            <span key={i} className="chat-node__attach-chip">
              <img src={`data:${img.mediaType};base64,${img.data}`} alt="attachment" />
              <button onClick={() => removeImage(i)}>×</button>
            </span>
          ))}
          {attachNote && <div className="chat-node__attach-note">{attachNote}</div>}
        </div>
      )}
      {chat?.error?.fatal ? (
        <div className="chat-node__errorbar nodrag">
          <span className="chat-node__errorbar-msg">{chat.error.message || 'Chat session ended.'}</span>
          <button
            className="chat-node__errorbar-reconnect"
            onClick={() => {
              clearError(id)
              void window.nodeTerminal.chat.ensure(id, {
                cwd: data.cwd as string | undefined,
                sessionId: data.chatSessionId as string | undefined,
                accountId: data.accountId as string | undefined
              })
            }}
          >
            Reconnect
          </button>
        </div>
      ) : (
      <div className="chat-node__compose nodrag">
        {slashOpen && (
          <div className="chat-node__slash">
            {slashMatches.map((c, i) => (
              <div
                key={c}
                className={`chat-node__slash-item${i === slashActive ? ' chat-node__slash-item--active' : ''}`}
                onMouseEnter={() => setSlashIdx(i)}
                onMouseDown={(e) => {
                  e.preventDefault() // keep focus on the textarea
                  completeSlash(c)
                }}
              >
                {c}
              </div>
            ))}
          </div>
        )}
        <textarea
          className="term-chat__input"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          onDragOver={onDragOver}
          placeholder={working ? 'Claude is working — message will queue…' : 'Message Claude…  (Enter to send)'}
          rows={2}
        />
        {/* Stop = interrupt: the driver's turn-done then auto-flushes the next queued item (Task 5). */}
        {working && <button className="chat-node__stop" onClick={() => window.nodeTerminal.chat.interrupt(id)}>Stop</button>}
      </div>
      )}
    </div>
  )
}
