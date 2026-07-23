// Injected prompts (context-link notes, note pushes, slash commands, dictation insert) are
// delivered through `tmux send-keys`. Sending the text and the Enter as two separate keystroke
// writes races the receiving TUI's paste heuristics: a composer that treats a rapid unmarked
// burst as a paste can absorb an Enter arriving milliseconds behind it as pasted content
// instead of a submit — observed with Claude Code hosted inside the herdr multiplexer (#47),
// whose input pipeline re-chunks the byte stream. When the target application has REQUESTED
// bracketed-paste mode (tmux tracks this per pane as `bracket_paste_flag`), deliver the
// injection the way paste-aware apps expect: the text framed in paste markers and the Enter
// appended in the SAME write, so the composer sees a definitive paste boundary and the Enter
// can never be re-chunked into the paste. Apps that never requested bracketed paste keep the
// legacy two-step delivery bit-for-bit.
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

/** The single-write injection body for a bracketed-paste-aware target. */
export function bracketedInjection(text: string, enter: boolean): string {
  return PASTE_START + text + PASTE_END + (enter ? '\r' : '')
}
