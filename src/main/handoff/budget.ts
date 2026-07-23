// Context budget for handoff bodies. The renderers deliberately never truncate, but a long
// session renders to megabytes — and a target agent that obeys "read the entire file first"
// walks straight into its own context ceiling, compacts, and forgets the handoff instruction
// entirely (field report: codex read the file, then reset to "What would you like to work
// on?"). So the PRIMARY handoff file is kept under a budget the target can actually afford:
// the most recent conversation verbatim (the live task state is at the end), older messages
// condensed to one-line digests, and the COMPLETE render preserved next to it for on-demand
// grep/range reads. Pure string work — unit-testable, no fs.

/** Primary handoff body budget, in characters (~40k tokens at 4 chars/token — well inside
 *  every target agent's window while leaving room for the session's own work). */
export const HANDOFF_BODY_BUDGET = 150_000
/** Of the budget, how much goes to the verbatim tail vs the digest of older messages. */
const TAIL_SHARE = 0.8

/** A `## User` / `## Assistant` message boundary (tool blocks are `###` and never match). */
const MESSAGE_HEADER = /^## /gm

export interface BudgetedHandoff {
  body: string
  truncated: boolean
}

/** One digest line for an omitted section; whitespace collapsed, hard-capped. */
function digestLine(section: string): string {
  const nl = section.indexOf('\n')
  const header = (nl === -1 ? section : section.slice(0, nl)).trim()
  const rest = (nl === -1 ? '' : section.slice(nl)).replace(/\s+/g, ' ').trim()
  const text = rest.length > 120 ? `${rest.slice(0, 120)}…` : rest
  return text ? `- ${header.replace(/^#+\s*/, '')}: ${text}` : `- ${header.replace(/^#+\s*/, '')}`
}

/** Digest the omitted head: one line per message, tool-block runs collapsed to a count. */
export function digestHead(head: string): string {
  const boundaries: number[] = []
  for (const m of head.matchAll(MESSAGE_HEADER)) boundaries.push(m.index)
  if (boundaries.length === 0) return ''
  const lines: string[] = []
  let toolRun = 0
  const flushTools = (): void => {
    if (toolRun > 0) lines.push(`- (${toolRun} tool call/result block${toolRun === 1 ? '' : 's'} omitted)`)
    toolRun = 0
  }
  for (let i = 0; i < boundaries.length; i++) {
    const section = head.slice(boundaries[i], boundaries[i + 1] ?? head.length)
    // Within a message section, everything up to the first `### ` is the message; the rest
    // are tool blocks — count them instead of digesting each (they dominate long sessions).
    const toolAt = section.search(/^### /m)
    const message = toolAt === -1 ? section : section.slice(0, toolAt)
    flushTools()
    lines.push(digestLine(message))
    if (toolAt !== -1) {
      toolRun = (section.slice(toolAt).match(/^### /gm) ?? []).length
      flushTools()
    }
  }
  flushTools()
  return lines.join('\n')
}

/**
 * Fit `body` into `budget` chars: verbatim tail from a message boundary + digested head.
 * Under-budget bodies pass through untouched (`truncated: false`).
 */
export function budgetHandoff(body: string, budget = HANDOFF_BODY_BUDGET, fullPath?: string): BudgetedHandoff {
  if (body.length <= budget) return { body, truncated: false }

  const tailBudget = Math.floor(budget * TAIL_SHARE)
  // Earliest message boundary whose suffix fits the tail budget.
  let tailStart = -1
  for (const m of body.matchAll(MESSAGE_HEADER)) {
    if (body.length - m.index <= tailBudget) {
      tailStart = m.index
      break
    }
  }
  // No boundary fits (one enormous trailing message): hard-cut mid-message rather than blow
  // the budget — the note below says so.
  const midMessage = tailStart === -1
  const tail = midMessage ? body.slice(-tailBudget) : body.slice(tailStart)
  const head = midMessage ? body.slice(0, body.length - tailBudget) : body.slice(0, tailStart)

  let digest = digestHead(head)
  const digestBudget = budget - tail.length - 1_500 // headroom for the note scaffolding
  if (digest.length > digestBudget) {
    // Keep the most recent digest lines; drop the oldest.
    const lines = digest.split('\n')
    while (lines.length > 1 && lines.join('\n').length > digestBudget) lines.shift()
    digest = `- … (earliest messages omitted)\n${lines.join('\n')}`
  }

  const note =
    `> **Note:** this handoff was condensed to fit your context. Older messages appear only ` +
    `as the one-line digest below; everything after the "VERBATIM FROM HERE" marker is the ` +
    `unmodified recent conversation${midMessage ? ' (cut mid-message to fit)' : ''} — the live ` +
    `task state is at the END of this file.` +
    (fullPath
      ? ` The COMPLETE transcript is at \`${fullPath}\` — read specific ranges or grep it on ` +
        `demand; do NOT read it whole.`
      : '')

  const parts = [note]
  if (digest) parts.push(`## Digest of earlier conversation\n\n${digest}`)
  parts.push(`---\n\nVERBATIM FROM HERE\n\n${tail}`)
  return { body: parts.join('\n\n'), truncated: true }
}
