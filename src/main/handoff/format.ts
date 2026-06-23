// Shared rendering helpers for cross-agent handoff transcript renderers. Pure (no fs).

/** Full text of a content value: a string as-is, an array of blocks joined, an object as
 *  JSON. Never truncates — handoff requires the complete content. Non-text blocks fall back
 *  to their JSON so nothing is silently dropped. */
export function blockText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object') {
          const o = c as Record<string, unknown>
          if (typeof o.text === 'string') return o.text
          return JSON.stringify(o)
        }
        return String(c)
      })
      .join('\n')
  }
  if (content && typeof content === 'object') return JSON.stringify(content)
  return ''
}

/** A pretty-printed, ```json-fenced block for tool inputs and unknown blocks. */
export function fenceJson(v: unknown): string {
  let s: string
  try {
    s = JSON.stringify(v, null, 2)
  } catch {
    s = String(v)
  }
  return '```json\n' + s + '\n```'
}
