// Pure tmux control-mode (-C) protocol codec. No I/O here — the client (tmux-control-client.ts)
// owns the process; this file owns the line protocol, so every parsing rule is unit-testable.
//
// Protocol: notifications are %-prefixed lines; command replies arrive as a
// `%begin <ts> <num> <flags>` … body … `%end|%error <ts> <num> <flags>` block; `%output %<pane> <data>`
// carries raw pane bytes with non-printables as \ooo octal escapes.

export type ControlEvent =
  | { kind: 'output'; paneId: string; data: string }
  | { kind: 'reply'; num: number; ok: boolean; body: string[] }
  | { kind: 'exited' }
  | { kind: 'other'; line: string }

/**
 * Undo tmux's `\ooo` escaping of an `%output` payload. One escape is one BYTE, so the result is a
 * byte-per-char string (latin1-style), not decoded UTF-8: a `ç` arrives as `\303\247` and comes back
 * as two chars. The caller re-assembles bytes before handing them to a UTF-8 decoder, which is also
 * what makes split multi-byte sequences across chunks survive.
 */
export function decodeOctal(s: string): string {
  return s.replace(/\\(\d{3}|\\)/g, (_, esc: string) =>
    esc === '\\' ? '\\' : String.fromCharCode(parseInt(esc, 8))
  )
}

/**
 * A `send-keys` command line that types `data` into `target`. Hex (`-H`) because a control-mode
 * command must fit on ONE text line: it sidesteps every quoting/UTF-8 hazard that `-l` literal mode
 * would need shell-grade escaping for.
 */
export function encodeSendKeysHex(target: string, data: string): string {
  const bytes = [...Buffer.from(data, 'utf8')].map((b) => b.toString(16).padStart(2, '0'))
  return `send-keys -t ${target} -H ${bytes.join(' ')}`
}

/**
 * A stateful line splitter over the control-mode stream. `push` takes an arbitrary chunk (partial
 * lines are held until their newline arrives) and returns the events it completed.
 */
export function createControlDecoder(): { push(chunk: string): ControlEvent[] } {
  let buf = ''
  let block: { num: number; body: string[] } | null = null
  return {
    push(chunk: string): ControlEvent[] {
      buf += chunk
      const out: ControlEvent[] = []
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (block) {
          // The terminator repeats the command number; tmux cannot interleave blocks, so the open
          // block's own num stays authoritative and only end-vs-error decides success.
          const done = line.match(/^%(end|error) \d+ \d+ \d+$/)
          if (done) {
            out.push({ kind: 'reply', num: block.num, ok: done[1] === 'end', body: block.body })
            block = null
          } else {
            block.body.push(line)
          }
          continue
        }
        const begin = line.match(/^%begin \d+ (\d+) \d+$/)
        if (begin) {
          block = { num: Number(begin[1]), body: [] }
        } else if (line.startsWith('%output ')) {
          const m = line.match(/^%output (%\d+) (.*)$/s)
          if (m) out.push({ kind: 'output', paneId: m[1], data: decodeOctal(m[2]) })
        } else if (line === '%exit' || line.startsWith('%exit ')) {
          out.push({ kind: 'exited' })
        } else if (line.startsWith('%')) {
          out.push({ kind: 'other', line })
        }
        // Non-% lines outside a block: tmux sends none in -C; drop silently.
      }
      return out
    }
  }
}
