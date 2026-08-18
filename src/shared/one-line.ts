// SECURITY — a string the CALLER believes is one line must not be able to become two.
//
// Several places compose a single submitted line out of a value they did not author:
//
//   `/rename ${title}`                     <- the canvas-control `rename` verb's --title
//   `[nodeterm] ... linked to "${title}"`  <- the same title, pushed into the OTHER session
//
// ...and hand it to `pty.sendText`, which appends Enter. A `\n` or `\r` inside the value ends the
// line early: everything after it becomes a SECOND submitted line in the target agent's composer —
// a command the target's operator never typed. `--title` is reachable over the canvas-control
// route, so the author of that second line can be another agent.
//
// This is not a new shape here. The recorded incident is the same one from the other side: a
// `sendText` + Enter into a shell-owned pane spliced the launch command that was being typed
// (`renderer/lib/sessionRename.ts` carries the gate that came out of it). A control-supplied
// string reaching a submitted line is known-dangerous, not hypothetical.
//
// WHY A CHARACTER CLASS RATHER THAN `\r|\n`
// The receiver is an agent REPL, a readline shell, a tmux pane — each with its own idea of which
// byte ends a line. LF and CR are the obvious two; readline also takes C-j (LF) as accept-line,
// C-k (VT, 0x0b) truncates the line, C-l (FF) redraws it, ESC opens a sequence, and a raw NUL has
// already cost this repo a day (NUL bytes made source files invisible to git and ripgrep).
// Enumerating which control a given receiver honours is the game this repo keeps losing, so the
// rule is instead: a value that is meant to be ONE LINE OF TEXT has no business carrying ANY
// control character. None of them has a glyph, so removing them costs the visible text nothing.
//
// Deliberately NOT in scope: values that are multi-line BY INTENT — a prompt body, a `write
// --text` payload a human approves in a dialog, a dictation insert, an `open-terminal --cmd`
// command line. Those are not "one line the caller composed".
//
// Complements, and does not overlap, the paste-frame sanitizer (`core/paste-injection.ts`): that
// one keeps a payload from expressing paste STRUCTURE during DELIVERY and must keep newlines,
// because a paste legitimately contains them. This one runs a layer earlier, at COMPOSITION,
// where a newline is never legitimate.

/**
 * Characters that can end or rewrite a composed line, matched as a RUN together with any spaces
 * around OR BETWEEN them (so `a\r\n \r\nb` collapses to one space, not two): C0 controls (LF, CR,
 * VT, FF, ESC, NUL, TAB and the rest), DEL, the C1 range (0x80-0x9f — NEL is a line break there,
 * and 0x9b is an 8-bit CSI), and Unicode's line/paragraph separators, named by PROPERTY
 * (`\p{Zl}`, `\p{Zp}`) rather than
 * written out: they are invisible, and this repo has already lost a day to a source file made
 * unreadable to git and ripgrep by a character nobody could see in it.
 */
// eslint-disable-next-line no-control-regex
const NOT_ONE_LINE_RUN = / *(?:[\x00-\x1f\x7f-\x9f\p{Zl}\p{Zp}] *)+/gu

/**
 * Make `text` safe as ONE submitted line: every control run collapses to a single space, and the
 * result is trimmed.
 *
 * STRIP, not REJECT, at every site that calls this — the whole set is titles and the notes that
 * quote them, and there the two failure modes are not close. A title that quietly loses a newline
 * still names the session: every visible character survives, in order, and a title is cosmetic.
 * Refusing would leave the node title and the agent's session name permanently disagreeing over a
 * character nobody can see, with `sendText`'s boolean the only place to report it — and these
 * sites have no caller to answer anyway, since a title also arrives from the workspace file and
 * from `generateName`'s MODEL output, neither of which is a request that can be failed.
 *
 * REJECT would belong at a site whose value is EXECUTED and which can still answer its caller.
 * `open-terminal --cmd` looks like one and is not: nothing is composed around it — the caller's
 * bytes ARE the line — and that verb already runs whatever it is handed, so a `\n` in it buys an
 * attacker nothing it did not already have. It is left byte-for-byte alone, deliberately.
 *
 * Idempotent: the output contains no member of the class, so a second pass changes nothing.
 */
export function oneLine(text: string): string {
  return text.replace(NOT_ONE_LINE_RUN, ' ').trim()
}
