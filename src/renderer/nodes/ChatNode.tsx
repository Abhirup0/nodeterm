// SDK-driven chat node: token-streaming conversation with Claude, permission cards,
// send-while-working queue. Continuity is resume-based via data.chatSessionId — the
// SDK process dies with the app; history reloads from the on-disk transcript.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { MarkdownText } from './ChatPanel'
import { useChatSessions } from '../state/chatSessions'
import { useAgentStatus } from '../state/agentStatus'
import type { CanvasNode } from '../state/workspace'
import type { ChatImageAttachment } from '@shared/types'

export default function ChatNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const chat = useChatSessions((s) => s.byId[id])
  const apply = useChatSessions((s) => s.apply)
  const seed = useChatSessions((s) => s.seed)
  const addLocalUser = useChatSessions((s) => s.addLocalUser)
  const status = useAgentStatus((s) => s.byId[id])
  const { setNodes } = useReactFlow()
  const [input, setInput] = useState('')
  const [images, setImages] = useState<ChatImageAttachment[]>([])
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
    if (sessionId) void window.nodeTerminal.chat.readTranscript(sessionId, data.cwd as string | undefined).then((m) => seed(id, m))
    void window.nodeTerminal.chat.ensure(id, {
      cwd: data.cwd as string | undefined,
      sessionId,
      fork: !own && !!forkFrom ? true : undefined
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // Fork bootstrap: forkFrom carries the source session id until our own id arrives.
  // (ensure() above passes fork:true with sessionId=data.forkFrom when set — see Task 10.)

  useEffect(() => {
    const el = msgsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chat?.messages, chat?.streamText, chat?.streamThinking])

  const send = useCallback(() => {
    const text = input.trim()
    if (!text && images.length === 0) return
    window.nodeTerminal.chat.send(id, text, images.length ? images : undefined)
    if (!chat?.working) addLocalUser(id, text)
    setInput('')
    setImages([])
  }, [input, images, id, chat?.working, addLocalUser])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const perm = chat?.permission
  const working = !!chat?.working || status?.state === 'working'

  return (
    <div className={`chat-node${selected ? ' selected' : ''}`} style={{ borderTopColor: data.color }}>
      <NodeResizer isVisible={selected} minWidth={360} minHeight={280} />
      <div className="chat-node__header">
        <span className="chat-node__title">{(data.title as string) || 'Chat'}</span>
        {working && <span className="chat-node__badge chat-node__badge--working">RUNNING</span>}
        {perm && <span className="chat-node__badge chat-node__badge--needs">NEEDS YOU</span>}
        {chat && chat.costUsd > 0 && <span className="chat-node__cost">${chat.costUsd.toFixed(2)}</span>}
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
                <details key={j} className="term-chat__tool">
                  <summary><span className="term-chat__tool-name">{p.name}</span><span className="term-chat__tool-arg">{p.arg}</span></summary>
                  {p.result && <pre className="term-chat__tool-result">{p.result}</pre>}
                </details>
              )
            )}
          </div>
        ))}
        {/* Live turn: streaming thinking + text + tool cards */}
        {chat?.streamThinking && (
          <details className="chat-node__thinking"><summary>Thinking…</summary><MarkdownText text={chat.streamThinking} /></details>
        )}
        {chat?.toolOrder.map((tid) => {
          const t = chat.tools[tid]
          return (
            <details key={tid} className="term-chat__tool" open={!t.result}>
              <summary>
                <span className="term-chat__tool-name">{t.name}</span>
                <span className="term-chat__tool-arg">
                  {t.summary ? `${t.summary.filePath} +${t.summary.added} −${t.summary.removed}` : t.arg}
                </span>
              </summary>
              {t.result && <pre className="term-chat__tool-result">{t.result}</pre>}
            </details>
          )
        })}
        {chat?.streamText && <div className="term-chat__msg term-chat__msg--assistant"><MarkdownText text={chat.streamText} /></div>}
        {chat?.error && <div className="chat-node__error">{chat.error.message}</div>}
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
      <div className="chat-node__compose nodrag">
        <textarea
          className="term-chat__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={working ? 'Claude is working — message will queue…' : 'Message Claude…  (Enter to send)'}
          rows={2}
        />
        {/* Stop = interrupt: the driver's turn-done then auto-flushes the next queued item (Task 5). */}
        {working && <button className="chat-node__stop" onClick={() => window.nodeTerminal.chat.interrupt(id)}>Stop</button>}
      </div>
    </div>
  )
}
