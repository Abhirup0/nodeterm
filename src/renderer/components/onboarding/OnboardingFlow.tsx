import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SpeechModelInfo } from '@shared/types'
import { AGENT_CONFIG, BUILTIN_AGENT_IDS, type BuiltinAgentId } from '@shared/agents/config'
import { isHoldChord, shortcutKeyParts } from '@shared/shortcut'
import { keyLabel } from '@shared/platform-utils'
import { useSettings } from '../../state/settings'
import { useEntitlement } from '../../state/entitlement'
import {
  OnbBrandMark,
  OnbCheck,
  OnbGhostCanvas,
  SceneAgents,
  SceneDictation,
  SceneKanban,
  SceneNotify
} from './scenes'

const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

/** `large-v3-turbo` -> `"Large V3 Turbo"` (same rendering as Settings → Speech). */
function modelLabel(id: string): string {
  return id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function formatSize(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

/** Info step + the setting it configures, one per screen. Step 0 is the welcome cover. */
const STEP_COUNT = 5

/**
 * First-run setup tour: welcome → agents → dictation → kanban → notifications. Each step
 * pairs an animated scene with ONE decision, and every choice writes settings immediately
 * (there is no final "save" — closing mid-way keeps what was chosen so far). Replaces both
 * the auto-opened ShortcutsPanel and the standalone notification-consent dialog on first
 * launch; rerunnable via the ⌘K "Setup tour" command.
 */
export function OnboardingFlow({ onClose }: { onClose: () => void }) {
  const settings = useSettings((s) => s.settings)
  const update = useSettings((s) => s.update)
  const isPremium = useEntitlement((s) => s.isPremium)
  const [step, setStep] = useState(0)

  // ---- dictation models (loaded once; selection + download mirror Settings → Speech) ----
  const [models, setModels] = useState<SpeechModelInfo[]>([])
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [modelHint, setModelHint] = useState('')
  const refreshModels = useCallback(async () => {
    try {
      setModels(await window.nodeTerminal.speech.models())
    } catch {
      // transient read error — the list just stays empty and the step degrades to info-only
    }
  }, [])
  useEffect(() => {
    void refreshModels()
    const unsub = window.nodeTerminal.speech.onProgress(({ id, pct }) => {
      setProgress((p) => ({ ...p, [id]: pct }))
      if (pct >= 100) {
        setProgress((p) => {
          const next = { ...p }
          delete next[id]
          return next
        })
        void refreshModels()
      }
    })
    return unsub
  }, [refreshModels])

  const pickModel = (m: SpeechModelInfo): void => {
    if (m.pro && !isPremium) {
      setModelHint('Pro model — unlock later in Settings → License. Tiny is free and works offline.')
      return
    }
    setModelHint('')
    update({ speech: { ...settings.speech, model: m.id } })
    if (!m.downloaded && progress[m.id] === undefined) {
      setProgress((p) => ({ ...p, [m.id]: 0 }))
      window.nodeTerminal.speech.downloadModel(m.id).catch(() => {
        setProgress((p) => {
          const next = { ...p }
          delete next[m.id]
          return next
        })
        setModelHint('Download failed — you can retry any time in Settings → Speech.')
      })
    }
  }

  // ---- kanban try-it: catch a real ⌘⇧B while the step is up (capture phase, so the
  // canvas's own toggle handler never fires under the tour) ----
  const [kanbanTried, setKanbanTried] = useState(false)
  const [kanbanPulse, setKanbanPulse] = useState(0)
  useEffect(() => {
    if (step !== 3) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        e.stopPropagation()
        setKanbanTried(true)
        setKanbanPulse((n) => n + 1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [step])

  // Esc skips the tour (settings chosen so far are already saved).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // ---- notifications (last step: both choices finish the tour) ----
  const finishWithNotifications = (enable: boolean): void => {
    update({ notifyOnClaudeDone: enable, notifyConsentAsked: true })
    if (enable) {
      void window.nodeTerminal.notify({
        title: 'Notifications enabled',
        body: "You'll be told when an agent finishes in the background.",
        nodeId: '',
        force: true
      })
    }
    onClose()
  }

  // `defaultAgent` is always a launchable builtin per its doc, but the type is open — guard.
  const agentId: BuiltinAgentId = (BUILTIN_AGENT_IDS as readonly string[]).includes(settings.defaultAgent)
    ? (settings.defaultAgent as BuiltinAgentId)
    : 'claude'
  const agent = AGENT_CONFIG[agentId]
  const dictKeys = shortcutKeyParts(settings.speech.shortcut, isMac)
  const dictHold = isHoldChord(settings.speech.shortcut)

  const next = () => setStep((s) => Math.min(s + 1, STEP_COUNT - 1))
  const back = () => setStep((s) => Math.max(s - 1, 0))

  return createPortal(
    <div className="onb">
      {step === 0 && <OnbGhostCanvas />}
      <button className="onb-skip" onClick={onClose}>
        Skip setup
      </button>

      {step === 0 ? (
        <div className="onb-cover">
          <div className="onb-cover__brand">
            <OnbBrandMark />
            <span className="onb-cover__name">nodeterm</span>
          </div>
          <p className="onb-cover__tagline">A canvas of terminals — spatial, not stacked.</p>
          <div className="onb-cover__props">
            <div className="onb-prop">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="14" rx="2" />
                <path d="M7 9l3 2.5L7 14M12.5 14H17" />
              </svg>
              <span>Terminals never die — tmux keeps them running across restarts</span>
            </div>
            <div className="onb-prop">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
              </svg>
              <span>AI agents are first-class nodes — Claude, Codex, Gemini, opencode</span>
            </div>
            <div className="onb-prop">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="8" width="7" height="7" rx="1.5" />
                <rect x="6" y="14" width="7" height="7" rx="1.5" />
              </svg>
              <span>Lay your work out in space — pan, zoom, group, connect</span>
            </div>
          </div>
          <button className="onb-btn onb-btn--primary onb-cover__cta" autoFocus onClick={next}>
            Set up in a minute →
          </button>
        </div>
      ) : (
        <div className="onb-card">
          <div className="onb-scene">
            {step === 1 && <SceneAgents label={agent.label} color={agent.color} />}
            {step === 2 && <SceneDictation keys={dictKeys.map((k) => keyLabel(k, isMac))} hold={dictHold} />}
            {step === 3 && <SceneKanban pulseKey={kanbanPulse} />}
            {step === 4 && <SceneNotify />}
          </div>
          <div className="onb-pane">
            <div className="onb-step-no">Step {step} of {STEP_COUNT - 1}</div>

            {step === 1 && (
              <>
                <h2>Everything is a node</h2>
                <p>
                  Right-click the canvas to open a terminal — or an AI agent. Each one runs in
                  its own persistent tmux session.
                </p>
                <div className="onb-label">
                  Default agent (what {isMac ? '⌘⇧C' : 'Ctrl+Shift+C'} opens)
                </div>
                <div className="onb-agent-grid">
                  {BUILTIN_AGENT_IDS.map((id) => (
                    <button
                      key={id}
                      className={`onb-agent ${settings.defaultAgent === id ? 'is-selected' : ''}`}
                      onClick={() => update({ defaultAgent: id })}
                    >
                      <span className="onb-dot" style={{ background: AGENT_CONFIG[id].color }} />
                      {AGENT_CONFIG[id].label}
                    </button>
                  ))}
                </div>
                <div className="onb-fineprint">
                  Bring your own CLI too — add custom agents in Settings → Agents.
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <h2>Talk to your terminal</h2>
                <p>
                  {dictHold ? 'Hold' : 'Press'}{' '}
                  {dictKeys.map((k, i) => (
                    <kbd key={i} className="kbd">
                      {keyLabel(k, isMac)}
                    </kbd>
                  ))}{' '}
                  anywhere to dictate — on-device Whisper turns speech into text. Nothing is
                  sent to the cloud, and nothing auto-submits.
                </p>
                <div className="onb-label">Whisper model</div>
                <div className="onb-models">
                  {models.map((m) => {
                    const selected = settings.speech.model === m.id
                    const pct = progress[m.id]
                    return (
                      <button
                        key={m.id}
                        className={`onb-model ${selected ? 'is-selected' : ''} ${m.pro && !isPremium ? 'is-locked' : ''}`}
                        onClick={() => pickModel(m)}
                      >
                        <span className="onb-model__radio" />
                        <span className="onb-model__name">{modelLabel(m.id)}</span>
                        <span className="onb-model__size">{formatSize(m.sizeMB ?? m.approxMB)}</span>
                        {m.pro && <span className="onb-pro">PRO</span>}
                        {m.downloaded && (
                          <span className="onb-model__ok">
                            <OnbCheck />
                          </span>
                        )}
                        {pct !== undefined && (
                          <span className="onb-model__bar">
                            <span style={{ width: `${pct}%` }} />
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
                {modelHint && <div className="onb-fineprint">{modelHint}</div>}
              </>
            )}

            {step === 3 && (
              <>
                <h2>One project, two views</h2>
                <p>
                  Every project is a canvas — and also a kanban board. Cards are your live
                  sessions: drag them across columns, open them, comment on them.
                </p>
                <div className={`onb-tryit ${kanbanTried ? 'is-done' : ''}`}>
                  {kanbanTried ? (
                    <>
                      <OnbCheck /> That's the toggle — it works in any project.
                    </>
                  ) : (
                    <>
                      Try it now — press{' '}
                      {['⌘', '⇧', 'B'].map((k, i) => (
                        <kbd key={i} className="kbd">
                          {keyLabel(k, isMac)}
                        </kbd>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}

            {step === 4 && (
              <>
                <h2>Know when an agent needs you</h2>
                <p>
                  nodeterm can notify you when an agent finishes — or gets stuck waiting on an
                  approval — while you're somewhere else. Change any time in Settings →
                  Notifications.
                </p>
                <div className="onb-notify-actions">
                  <button className="onb-btn onb-btn--primary" autoFocus onClick={() => finishWithNotifications(true)}>
                    Enable notifications & finish
                  </button>
                  <button className="onb-btn" onClick={() => finishWithNotifications(false)}>
                    Not now — just finish
                  </button>
                </div>
              </>
            )}

            <div className="onb-nav">
              <div className="onb-dots">
                {Array.from({ length: STEP_COUNT }, (_, i) => (
                  <span key={i} className={i === step ? 'is-active' : ''} />
                ))}
              </div>
              <div className="onb-nav__btns">
                <button className="onb-btn" onClick={back}>
                  Back
                </button>
                {step < STEP_COUNT - 1 && (
                  <button className="onb-btn onb-btn--primary" onClick={next}>
                    Next
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  )
}
