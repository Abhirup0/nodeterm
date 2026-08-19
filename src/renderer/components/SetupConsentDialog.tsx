import { useEffect, useRef, useState } from 'react'
import type {
  ProjectSetupConsentAnswer,
  ProjectSetupConsentRequest,
  ProjectSetupKind
} from '@shared/project-settings'
import { oneLine } from '@shared/one-line'
import { ConfirmDialog } from './ConfirmDialog'

/**
 * THE TRUST GATE for a git-shared setup/archive script — the last thing between a cloned repo's
 * `.nodeterm/settings.json` and a spawn on this machine. Its properties are security-shaped, in
 * the same family as `CapabilityNotice` (the clone-arrived capability switch):
 *
 *  - IT SHOWS EVERYTHING THE ANSWER COVERS. One approval pins the whole `setup` family's hash
 *    (`projectTrustContent`), so the payload carries BOTH scripts and both are rendered. Showing
 *    only the one about to run would be approving the other unseen — the next archive would then
 *    execute code the user never read, under an approval they gave for something else.
 *  - ONLY THE TWO BUTTONS ARE ANSWERS. `enterConfirms={false}` shuts the window-keydown path and
 *    `autoFocusButtons={false}` means no button holds focus for a native Enter/Space — this dialog
 *    appears under the user's hands (a worktree they just created starts a setup run), and a
 *    keystroke aimed at a terminal must never approve a script. Escape and an overlay misclick
 *    submit NOTHING: they hide the prompt locally and leave the decision to main's expiry, which
 *    resolves an unanswered request as `undefined` (= not approved, nothing runs).
 *  - EXACTLY ONE SUBMISSION PER REQUEST, guarded by `answeredRef` — a double click must not send a
 *    second answer that a re-used requestId could apply to a different question.
 *
 * SECURITY — CROSS-BOUNDARY STRINGS: `projectName` and `locationLabel` come from a project file
 * that a stranger may have written (a cloned repo, a teammate's commit). The rule here is TEXT
 * ONLY: they are rendered as React text children (never interpolated into markup, a template that
 * gets parsed, a `title`/`href`, or anything handed to a terminal) and they are clamped by
 * `safeLabel` first — control characters stripped and the length capped — so neither an ANSI
 * escape run nor a 50 KB name can rewrite or overflow the dialog that is asking the question. The
 * SCRIPT BODIES are deliberately NOT clamped: they are the thing being approved, and truncating
 * them would mean the user approves bytes that were never on screen. They are rendered as text in
 * a scrollable `<pre>`, which is inert.
 *
 * KNOWN GAP (documented here, not fixable from this side — final-wave decision): a relay guest can
 * currently dispatch `project-setup:run` AND `project-setup:consent-submit` on the host
 * (`src/main/platform-electron.ts` — `dispatch` forbids only `githubControl:` methods), so a guest
 * could trigger a prompt and then answer it themselves without the host's user touching anything.
 * That is a main-side ADMISSION question — which methods a non-host peer may call — and no dialog
 * property can close it: this component cannot tell whose IPC message reached main. It is recorded
 * for the final wave's admission decision.
 */

/** Longest a name/location may be on screen, in characters. */
export const SETUP_LABEL_MAX = 200

/** Clamp for a cross-boundary label: control characters out (see `oneLine` — a name is one line of
 *  text and no control character has a glyph), then capped with an ellipsis. */
function safeLabel(raw: string): string {
  const flat = oneLine(raw)
  return flat.length > SETUP_LABEL_MAX ? flat.slice(0, SETUP_LABEL_MAX - 1) + '…' : flat
}

const KIND_LABEL: Record<ProjectSetupKind, string> = { setup: 'Setup', archive: 'Archive' }

/** The family's scripts, the one about to run FIRST, skipping the ones the family does not set. */
function orderedScripts(req: ProjectSetupConsentRequest): { kind: ProjectSetupKind; body: string }[] {
  const order: ProjectSetupKind[] = req.kind === 'archive' ? ['archive', 'setup'] : ['setup', 'archive']
  return order
    .map((kind) => ({ kind, body: req.scripts[kind] }))
    .filter((s): s is { kind: ProjectSetupKind; body: string } => s.body !== undefined)
}

export function SetupConsentDialog(): React.JSX.Element | null {
  // A QUEUE, not a single request: two projects (or a run and a worktree archive) can ask at once,
  // and answering one must not lose the other. The head is the one on screen.
  const [queue, setQueue] = useState<ProjectSetupConsentRequest[]>([])
  // Request ids already answered from here. Belt-and-braces against a double click landing before
  // the re-render drops the head — main treats an unknown/stale id as a no-op, but a second answer
  // must never leave this component in the first place.
  const answeredRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const api = window.nodeTerminal.projectSetup
    const offRequest = api.onConsentRequest((req) => {
      setQueue((q) => (q.some((r) => r.requestId === req.requestId) ? q : [...q, req]))
    })
    // main answered (or expired) this one itself — drop it, silently and without submitting.
    const offDismiss = api.onConsentDismiss(({ requestId }) => {
      setQueue((q) => q.filter((r) => r.requestId !== requestId))
    })
    return () => {
      offRequest()
      offDismiss()
    }
  }, [])

  const head = queue[0]
  if (!head) return null

  const drop = (requestId: string): void =>
    setQueue((q) => q.filter((r) => r.requestId !== requestId))

  const answer = (a: ProjectSetupConsentAnswer): void => {
    if (answeredRef.current.has(head.requestId)) return
    answeredRef.current.add(head.requestId)
    void window.nodeTerminal.projectSetup.consent(head.requestId, a)
    drop(head.requestId)
  }

  const name = safeLabel(head.projectName)
  const location = safeLabel(head.locationLabel)

  return (
    <ConfirmDialog
      // Keyed per request: the next prompt in the queue must be a FRESH dialog — its own
      // arm-window (CONFIRM_ARM_MS) and its own stack id, never one that inherited the timer of
      // the prompt the user just answered.
      key={head.requestId}
      body={
        <div className="confirm__msg space-y-2">
          <p className="text-[13px] text-muted">{location}</p>
          {head.previouslyApproved ? (
            <p className="text-[13px] text-[color:var(--warn)]">
              These scripts have changed since you approved them for this project.
            </p>
          ) : null}
          <p className="text-[13px] text-muted">
            They come from the project&apos;s shared <code>.nodeterm/settings.json</code>, so anyone
            who can commit to the repo can change them. One answer covers both.
          </p>
          {orderedScripts(head).map((s) => (
            <div key={s.kind} className="space-y-1">
              <p className="text-[12px] font-semibold text-text">
                {KIND_LABEL[s.kind]} script{s.kind === head.kind ? ' (about to run)' : ''}
              </p>
              {/* Text child, never markup — and never truncated: this is what is being approved. */}
              <pre
                data-script-kind={s.kind}
                className={`max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2.5 py-2 font-mono text-[12px] leading-relaxed text-text ${
                  s.kind === head.kind ? 'border-accent bg-bg' : 'border-border bg-bg opacity-80'
                }`}
              >
                {s.body}
              </pre>
            </div>
          ))}
        </div>
      }
      message={`Run the ${KIND_LABEL[head.kind].toLowerCase()} script for "${name}"?`}
      confirmLabel="Run once"
      cancelLabel="Skip"
      // "Run once" is the grant, so it carries the danger styling; no button takes focus.
      danger
      enterConfirms={false}
      autoFocusButtons={false}
      onConfirm={() => answer('approve')}
      onCancel={() => answer('skip')}
      onDismiss={() => {
        // NOT an answer. Nothing is submitted: main's pending request expires on its own and
        // resolves as unanswered, which runs nothing. Only the local prompt goes away.
        drop(head.requestId)
      }}
    />
  )
}
