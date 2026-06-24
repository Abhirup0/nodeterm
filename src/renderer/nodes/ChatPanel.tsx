import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { renderMarkdown } from '../lib/markdown'
import { useAgentStatus } from '../state/agentStatus'
import type { ChatMessage } from '@shared/types'

interface ChatPanelProps {
  nodeId: string
  sessionId?: string
  cwd?: string
}

/**
 * Chat view for a chat-capable agent node (Cmd+M). Renders the session transcript as
 * markdown bubbles with collapsible tool calls, and sends new prompts into the running tmux
 * session via pty.sendText. Phase 1 reloads the transcript whenever a turn finishes
 * (working -> idle); live streaming is a later phase. Replaces the markdown-of-output overlay.
 */
export function ChatPanel({ nodeId, sessionId, cwd }: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [readonly, setReadonly] = useState(false)
  const state = useAgentStatus((s) => s.byId[nodeId]?.state)
  const msgsRef = useRef<HTMLDivElement>(null)
  const prevState = useRef(state)

  const load = useCallback(() => {
    void window.nodeTerminal.chat.readTranscript(sessionId, cwd).then(setMessages)
  }, [sessionId, cwd])

  // Initial load.
  useEffect(() => {
    load()
  }, [load])

  // Reload when a turn completes (working -> not working).
  useEffect(() => {
    if (prevState.current === 'working' && state !== 'working') load()
    prevState.current = state
  }, [state, load])

  // Keep pinned to the latest message.
  useEffect(() => {
    const el = msgsRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const working = state === 'working'

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || working) return
    const ok = await window.nodeTerminal.pty.sendText(nodeId, text)
    if (!ok) {
      setReadonly(true)
      return
    }
    // Optimistic: show the prompt immediately; the next load() reconciles from the transcript.
    setMessages((m) => [...m, { role: 'user', parts: [{ kind: 'text', text }] }])
    setInput('')
  }, [input, working, nodeId])

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void send()
    }
  }

  return (
    <div className="term-chat nodrag nowheel">
      <div className="term-chat__bar">
        <span>Chat</span>
        <span className="term-chat__hint">⌘M to exit</span>
      </div>
      <div className="term-chat__msgs" ref={msgsRef}>
        {messages.length === 0 && <div className="term-chat__empty">No conversation yet.</div>}
        {messages.map((m, i) => (
          <div key={i} className={`term-chat__msg term-chat__msg--${m.role}`}>
            {m.parts.map((p, j) =>
              p.kind === 'text' ? (
                <div
                  key={j}
                  className="term-chat__text"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(p.text) }}
                />
              ) : (
                <details key={j} className="term-chat__tool">
                  <summary>
                    <span className="term-chat__tool-name">{p.name}</span>
                    {p.arg && <span className="term-chat__tool-arg">{p.arg}</span>}
                  </summary>
                  {p.result && <pre className="term-chat__tool-result">{p.result}</pre>}
                </details>
              )
            )}
          </div>
        ))}
      </div>
      <div className="term-chat__compose">
        <textarea
          className="term-chat__input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            readonly
              ? "Can't write to this session"
              : working
                ? 'Claude is working…'
                : 'Message Claude…  (Enter to send)'
          }
          disabled={readonly || working}
          rows={2}
        />
      </div>
    </div>
  )
}
