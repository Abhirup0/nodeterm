import { useEffect, useRef, useState } from 'react'
import type {
  ProjectConsentRequest,
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
 * `safeLabel` first — control characters, bidi overrides and zero-width marks stripped, then the
 * length capped — so neither an ANSI escape run, a U+202E that reverses the location, nor a 50 KB
 * name can rewrite or overflow the dialog that is asking the question.
 *
 * The SCRIPT BODIES are deliberately NOT clamped: they are the thing being approved, and stripping
 * or truncating them would mean the user approves bytes that were never on screen. They are
 * rendered as text in a scrollable `<pre>`, which is inert — and that `<pre>` carries
 * `unicode-bidi: bidi-override; direction: ltr`, which defeats Trojan-source reordering (a U+202E
 * inside a script making a comment read as executable code, or vice versa) by pinning the DISPLAY
 * order to the byte order, WITHOUT altering a single byte of what is approved and run.
 *
 * WHO MAY ANSWER (closed in the final wave, main-side — nothing here could have closed it): a
 * relay guest could otherwise dispatch `project-setup:run` and then cast
 * `project-setup:consent-submit`, triggering a prompt and approving it itself with the host's user
 * never touching anything. Both channels are now HOST-ONLY at the admission seam
 * (`src/shared/host-control.ts`, enforced in `dispatch` AND `cast` in
 * `src/main/platform-electron.ts`), and the prompt itself is delivered to the host's main window
 * only (`ProjectSetupService`'s `sendConsent`) instead of the peer-fanning broadcast — so the
 * script bytes rendered below are never disclosed to a guest either. This component still cannot
 * tell whose message reached main; it does not have to.
 */

/** Longest a name/location may be on screen, in characters. */
export const SETUP_LABEL_MAX = 200

/**
 * Characters a cross-boundary LABEL may never contain — the same class, for the same reason, that
 * `capName` strips from a presence display name (`src/shared/presence.ts`, `UNSAFE_NAME_CHARS`,
 * where the rationale is written out): a bidi override (U+202E) reverses everything after it, so
 * "app" + U+202E + "hs.live-nur" DISPLAYS as a different location than the one that inspects out
 * of the file, and the zero-width marks/isolates (U+200B-200F, U+2066-2069, U+FEFF) do the same
 * job invisibly. Replicated rather than imported because that constant is private to the presence
 * module and its cap (`capName`) is a different one; keep the two in step.
 */
const UNSAFE_LABEL_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g

/** Clamp for a cross-boundary label: control characters out (see `oneLine` — a label is one line of
 *  text and no control character has a glyph), then the bidi/zero-width spoofing set out, then
 *  capped with an ellipsis. */
function safeLabel(raw: string): string {
  const flat = oneLine(raw.replace(UNSAFE_LABEL_CHARS, '')).trim()
  return flat.length > SETUP_LABEL_MAX ? flat.slice(0, SETUP_LABEL_MAX - 1) + '…' : flat
}

const KIND_LABEL: Record<ProjectSetupKind, string> = { setup: 'Setup', archive: 'Archive' }

/**
 * The pin that defeats Trojan-source reordering on APPROVED BYTES (a script body, a launch command,
 * an env value, a shell path): it forces the DISPLAY order to the byte order, so a U+202E inside
 * the content cannot make the reader see a different program than the one that will run. It alters
 * nothing about the bytes themselves — which is the point: these are shown so they can be approved.
 */
const BIDI_PIN: React.CSSProperties = { unicodeBidi: 'bidi-override', direction: 'ltr' }

/** The scroll box every approved-bytes block sits in. Carries NO conflicting utility (no border
 *  colour, no whitespace mode): each use adds its own, so two Tailwind classes of the same family
 *  never race — the winner of that race is stylesheet order, not string order. */
const APPROVED_BOX =
  'max-h-40 overflow-auto break-words rounded-md border bg-bg px-2.5 py-2 font-mono text-[12px] leading-relaxed text-text'

/** The family's scripts, the one about to run FIRST, skipping the ones the family does not set. */
function orderedScripts(req: ProjectSetupConsentRequest): { kind: ProjectSetupKind; body: string }[] {
  const order: ProjectSetupKind[] = req.kind === 'archive' ? ['archive', 'setup'] : ['setup', 'archive']
  return order
    .map((kind) => ({ kind, body: req.scripts[kind] }))
    .filter((s): s is { kind: ProjectSetupKind; body: string } => s.body !== undefined)
}

/**
 * Which variant's content this request carries, or `null` for one this build cannot render.
 *
 * An untagged payload is the SETUP request — the only variant that predates the tag — so an older
 * main is still answered correctly. An unknown tag is refused outright rather than rendered as the
 * nearest variant: the whole point of this dialog is that nothing is approved that was not on
 * screen, and a payload whose content this build cannot lay out is content it cannot show.
 */
function familyOf(req: ProjectConsentRequest): ProjectConsentRequest['family'] | null {
  const tag = (req as { family?: string }).family ?? 'setup'
  return tag === 'setup' || tag === 'agents' || tag === 'shell' ? tag : null
}

export function SetupConsentDialog(): React.JSX.Element | null {
  // A QUEUE, not a single request: two projects (or a run and a worktree archive) can ask at once,
  // and answering one must not lose the other. The head is the one on screen.
  const [queue, setQueue] = useState<ProjectConsentRequest[]>([])
  // Request ids already answered from here. Belt-and-braces against a double click landing before
  // the re-render drops the head — main treats an unknown/stale id as a no-op, but a second answer
  // must never leave this component in the first place.
  const answeredRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    const api = window.nodeTerminal.projectSetup
    const offRequest = api.onConsentRequest((req) => {
      // Unrenderable variants never enter the queue at all — they must neither raise a dialog nor
      // block the ones behind them (see `familyOf`).
      if (!familyOf(req)) return
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

  // Per variant: the question, the grant button's wording, and the content the answer covers. The
  // `setup` arm is the fallback, so an untagged (older-main) payload renders exactly as before.
  const view =
    head.family === 'agents'
      ? {
          message: `Use the shared agent launch settings for "${name}"?`,
          confirmLabel: 'Approve',
          changed: 'These settings have changed since you approved them for this project.',
          intro: (
            <>
              They come from the project&apos;s shared <code>.nodeterm/settings.json</code>, so anyone
              who can commit to the repo can change them. One answer covers the launch command and
              every variable below.
            </>
          ),
          detail: (
            <>
              {head.launchCmd !== undefined ? (
                <div className="space-y-1">
                  <p className="text-[12px] font-semibold text-text">Launch command</p>
                  {/* Text child, never markup — and never truncated: this is what is approved. */}
                  <pre
                    style={BIDI_PIN}
                    data-launch-cmd=""
                    className={`${APPROVED_BOX} whitespace-pre-wrap border-accent`}
                  >
                    {head.launchCmd}
                  </pre>
                </div>
              ) : null}
              {head.env ? (
                <div className="space-y-1">
                  <p className="text-[12px] font-semibold text-text">Environment</p>
                  {/* Every pair, verbatim: an env var is code's blast radius (PATH/LD_PRELOAD), so
                      it is inside the hash and must be inside the question. The whole ROW is pinned
                      to byte order, key included — a `KEY=value` line that renders in some other
                      order than its bytes is the same Trojan-source problem as a reordered script,
                      and this dialog must not depend on the sanitizer's key charset to be safe. */}
                  <div className={`${APPROVED_BOX} border-accent`}>
                    {Object.entries(head.env).map(([key, value]) => (
                      <div key={key} data-env-key={key} style={BIDI_PIN} className="break-all">
                        <span className="text-muted">{key}=</span>
                        <span data-env-value="">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )
        }
      : head.family === 'shell'
        ? {
            message: `Use the shared terminal shell for "${name}"?`,
            confirmLabel: 'Approve',
            changed: 'This setting has changed since you approved it for this project.',
            intro: (
              <>
                It comes from the project&apos;s shared <code>.nodeterm/settings.json</code>, so anyone
                who can commit to the repo can change it. Every terminal you open for this project
                starts this program.
              </>
            ),
            detail: (
              <div className="space-y-1">
                <p className="text-[12px] font-semibold text-text">Shell</p>
                <pre
                  style={BIDI_PIN}
                  data-shell=""
                  className={`${APPROVED_BOX} whitespace-pre-wrap border-accent`}
                >
                  {head.shell}
                </pre>
              </div>
            )
          }
        : {
            message: `Run the ${KIND_LABEL[head.kind].toLowerCase()} script for "${name}"?`,
            confirmLabel: 'Run once',
            changed: 'These scripts have changed since you approved them for this project.',
            intro: (
              <>
                They come from the project&apos;s shared <code>.nodeterm/settings.json</code>, so
                anyone who can commit to the repo can change them. One answer covers both.
              </>
            ),
            detail: (
              <>
                {orderedScripts(head).map((s) => (
                  <div key={s.kind} className="space-y-1">
                    <p className="text-[12px] font-semibold text-text">
                      {KIND_LABEL[s.kind]} script{s.kind === head.kind ? ' (about to run)' : ''}
                    </p>
                    {/* Text child, never markup — and never truncated: this is what is being
                        approved. `BIDI_PIN` pins the DISPLAY order to the byte order, so a U+202E in
                        the script cannot make the reader see a different program than the one that
                        will run (Trojan source). It changes nothing about the bytes themselves. */}
                    <pre
                      style={BIDI_PIN}
                      data-script-kind={s.kind}
                      className={`max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border px-2.5 py-2 font-mono text-[12px] leading-relaxed text-text ${
                        s.kind === head.kind ? 'border-accent bg-bg' : 'border-border bg-bg opacity-80'
                      }`}
                    >
                      {s.body}
                    </pre>
                  </div>
                ))}
              </>
            )
          }

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
            <p className="text-[13px] text-[color:var(--warn)]">{view.changed}</p>
          ) : null}
          <p className="text-[13px] text-muted">{view.intro}</p>
          {view.detail}
        </div>
      }
      message={view.message}
      confirmLabel={view.confirmLabel}
      cancelLabel="Skip"
      // The confirm button is the grant, so it carries the danger styling; no button takes focus.
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
