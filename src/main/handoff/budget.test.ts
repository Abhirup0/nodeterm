import { describe, it, expect } from 'vitest'
import { budgetHandoff, digestHead, HANDOFF_BODY_BUDGET } from './budget'

/** A rendered transcript in the shape the renderers emit: `## ` messages, `### ` tool blocks. */
function transcript(messages: number, toolBlocksPer = 2, filler = 400): string {
  const parts: string[] = []
  for (let i = 0; i < messages; i++) {
    const role = i % 2 === 0 ? 'User' : 'Assistant'
    parts.push(`## ${role}\n\nmessage ${i} ${'x'.repeat(filler)}`)
    for (let t = 0; t < toolBlocksPer; t++) {
      parts.push(`### Tool call: Bash\n\n\`\`\`json\n{"cmd":"echo ${i}-${t}"}\n\`\`\``)
      parts.push('### Tool result\n\n```\nout\n```')
    }
  }
  return parts.join('\n\n')
}

describe('budgetHandoff', () => {
  it('passes an under-budget body through untouched', () => {
    const body = transcript(3)
    expect(budgetHandoff(body)).toEqual({ body, truncated: false })
  })

  it('fits an over-budget body inside the budget', () => {
    const body = transcript(600, 4, 800) // well over the default budget
    const out = budgetHandoff(body)
    expect(out.truncated).toBe(true)
    expect(out.body.length).toBeLessThanOrEqual(HANDOFF_BODY_BUDGET)
  })

  it('keeps the tail verbatim from a message boundary — the end of the file is the live task', () => {
    const body = transcript(200, 2, 600)
    const out = budgetHandoff(body, 40_000)
    // The final message must appear verbatim.
    expect(out.body).toContain('message 199 ')
    // The verbatim region starts at a `## ` message header, never inside a tool block.
    // (lastIndexOf: the note ABOVE quotes the marker string when explaining the layout.)
    const marker = out.body.lastIndexOf('VERBATIM FROM HERE')
    expect(marker).toBeGreaterThan(-1)
    const after = out.body.slice(marker + 'VERBATIM FROM HERE'.length).trimStart()
    expect(after.startsWith('## ')).toBe(true)
  })

  it('digests omitted messages and collapses tool-block runs to counts', () => {
    // Budget chosen so the digest fits whole: every omitted message keeps its line
    // (message 0 included) alongside the collapsed tool-run counters.
    const body = transcript(40, 3, 300)
    const out = budgetHandoff(body, 20_000)
    expect(out.truncated).toBe(true)
    expect(out.body).toContain('## Digest of earlier conversation')
    expect(out.body).toMatch(/- User: message 0 /)
    expect(out.body).toMatch(/tool call\/result blocks omitted/)
  })

  it('references the full-copy path and warns against whole-file reads', () => {
    const out = budgetHandoff(transcript(200, 2, 600), 40_000, '/tmp/h-full.md')
    expect(out.body).toContain('/tmp/h-full.md')
    expect(out.body).toContain('do NOT read it whole')
  })

  it('hard-cuts when a single trailing message alone exceeds the tail budget', () => {
    const body = `## User\n\nsmall\n\n## Assistant\n\n${'y'.repeat(100_000)}`
    const out = budgetHandoff(body, 20_000)
    expect(out.truncated).toBe(true)
    expect(out.body.length).toBeLessThanOrEqual(21_000)
    expect(out.body).toContain('cut mid-message')
    // The very end is still the end of the conversation.
    expect(out.body.endsWith('y'.repeat(50))).toBe(true)
  })

  it('caps a huge digest by dropping the OLDEST lines', () => {
    const body = transcript(3000, 0, 40)
    const out = budgetHandoff(body, 30_000)
    expect(out.body.length).toBeLessThanOrEqual(30_000)
    expect(out.body).toContain('earliest messages omitted')
    // Recent digest lines survive; the oldest are gone.
    expect(out.body).not.toMatch(/- User: message 0 /)
  })
})

describe('digestHead', () => {
  it('is empty for a head with no message boundaries', () => {
    expect(digestHead('no headers here')).toBe('')
  })
  it('one line per message with collapsed whitespace', () => {
    const d = digestHead('## User\n\nline one\nline two\n\n## Assistant\n\nreply')
    expect(d.split('\n')).toEqual(['- User: line one line two', '- Assistant: reply'])
  })
})
