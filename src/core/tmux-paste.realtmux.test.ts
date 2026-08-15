// THE DELIVERY, PROVEN AGAINST A REAL TMUX DRIVING A REAL APPLICATION.
//
// The subject is `sendText`'s one-round-trip paste: `load-buffer -` over stdin, a copy-mode
// cancel gated by `if-shell -F`, then `paste-buffer -d -p -r`, then Enter. Both the LOCAL argv
// (`localTmuxPasteArgs`) and the REMOTE command line (`remoteTmuxPasteArgs`, run through a real
// /bin/sh) are driven here, against the same panes, and asserted to produce the SAME bytes —
// parity is the property that kept breaking when the two paths were written twice.
//
// WHAT JUDGES. Not a parser of ours, and not tmux's own `#{bracket_paste_flag}` (which is the
// thing being removed, and which does not even exist on this host's tmux 3.4). The pane runs a
// program that puts its tty in RAW mode and appends every byte it receives to a file: the frame
// either arrives on the application's stdin or it does not. For the security cases the pane runs
// a real interactive bash — readline's own bracketed-paste implementation — and the verdict is
// whether a file the payload asked for exists.
//
// WHY THIS FILE EXISTS AT ALL. The previous delivery asked tmux "did the app request bracketed
// paste?" via `#{bracket_paste_flag}`, a format that first shipped in TMUX 3.7 (2026-06-26). On
// anything older it expands to '' and the code read that as "no" — then delivered the text with
// RAW NEWLINES, one submit per line. Every assertion below that names the version floor is a
// measurement of that, taken here, on this tmux.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { localTmuxPasteArgs, pasteBufferName } from './tmux-naming'
import { remoteTmuxPasteArgs, remoteTmuxEnterArgs } from './remote-ssh/control-master'
import { sanitizePasteText } from './paste-injection'

const ESC = '\x1b'
const START = `${ESC}[200~`
const END = `${ESC}[201~`
/** A private socket — never `TMUX_SOCKET`/`nodeterm-rmt`, which carry live user sessions. */
const SOCKET = `nt-paste-test-${process.pid}`
const CONN = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }

function findTmux(): string | null {
  for (const c of ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux']) {
    if (fs.existsSync(c)) return c
  }
  return null
}
const TMUX = findTmux()

let work: string
let binDir: string

/**
 * The socket file lives in the test's OWN dir: `kill-server` does not unlink it, so a per-pid name
 * under the shared `/tmp/tmux-<uid>/` would leave one stale entry behind per run, forever.
 */
function env(): NodeJS.ProcessEnv {
  return { ...process.env, TMUX_TMPDIR: work }
}

function tmux(args: string[], input?: string): string {
  return execFileSync(TMUX as string, args, { encoding: 'utf8', env: env(), input })
}

/**
 * `tmux`, ignoring the exit status — for the CONTROL cases, which are about what reached the
 * application, not about what tmux told its client. (A tmux server shared by several clients
 * hands a failing command's error to whichever client is listening, so an exit code here is not
 * a property of the command that produced it.)
 */
function tryTmux(args: string[], input?: string): void {
  try {
    tmux(args, input)
  } catch {
    // the bytes are the witness
  }
}

beforeAll(() => {
  if (!TMUX) return
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ntpb-'))
  binDir = path.join(work, 'bin')
  fs.mkdirSync(binDir)
  // The SSH path's shim. `remoteTmuxPasteArgs` hard-codes `-L nodeterm-rmt`, which on a real host
  // is the socket a remote nodeterm owns; here the first two arguments are dropped and the real
  // tmux is re-invoked on the test's private socket. `exec` keeps stdin, which is the whole point
  // of the path being tested.
  fs.writeFileSync(
    path.join(binDir, 'tmux'),
    `#!/bin/sh\nexport TMUX_TMPDIR=${work}\nshift 2\nexec ${TMUX} -L ${SOCKET} "$@"\n`,
    { mode: 0o755 }
  )
  // A pane program that records the RAW bytes its stdin receives. `stty raw` matters: in cooked
  // mode the line discipline rewrites CR to NL on input, which would hide exactly the `\n` vs
  // `\r` distinction this file is about.
  fs.writeFileSync(
    path.join(binDir, 'recorder'),
    [
      '#!/bin/sh',
      'stty raw -echo',
      // $2 = "aware": announce DECSET 2004, i.e. request bracketed paste, the way a TUI does.
      '[ "$2" = aware ] && printf \'\\033[?2004h\'',
      'touch "$1.ready"',
      'exec cat > "$1"'
    ].join('\n') + '\n',
    { mode: 0o755 }
  )
})

afterAll(() => {
  if (TMUX) {
    try {
      tmux(['-L', SOCKET, 'kill-server'])
    } catch {
      // already gone
    }
  }
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

function waitFor(predicate: () => boolean, what: string, ms = 10_000): void {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    execFileSync('sleep', ['0.03'])
  }
}

/** A fresh single-pane session running the byte recorder. Returns the file it writes to. */
function recorderPane(session: string, kind: 'aware' | 'unaware'): string {
  const out = path.join(work, `${session}.bytes`)
  try {
    execFileSync(TMUX as string, ['-L', SOCKET, 'kill-session', '-t', `=${session}`], {
      stdio: 'ignore',
      env: env()
    })
  } catch {
    // no such session yet
  }
  tmux([
    '-L',
    SOCKET,
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '200',
    '-y',
    '40',
    '-c',
    work,
    `${binDir}/recorder ${out} ${kind}`
  ])
  waitFor(() => fs.existsSync(`${out}.ready`), `${session} recorder to come up`)
  return out
}

/**
 * Everything sent before this call has reached the application.
 *
 * A sentinel, not a sleep, and deliberately delivered by a DIFFERENT mechanism than the subject
 * (a plain literal `send-keys`): if the subject delivered nothing at all, the marker still shows
 * up and the assertion sees an empty payload rather than hanging.
 */
const MARK = '<<NTEND>>'
function drain(session: string, out: string): string {
  tmux(['-L', SOCKET, 'send-keys', '-t', session, '-l', '--', MARK])
  waitFor(() => fs.readFileSync(out, 'utf8').includes(MARK), `${session} to receive the marker`)
  const all = fs.readFileSync(out, 'utf8')
  return all.slice(0, all.lastIndexOf(MARK))
}

/**
 * The delivery under test, exactly as `PtyManager.sendText` performs it — including the one thing
 * that stays OURS: `sanitizePasteText`, applied to the payload before it enters the buffer. tmux
 * inserting the frame does not make a payload-supplied `ESC[201~` harmless.
 */
function send(pathName: 'local' | 'ssh', session: string, text: string, enter = true): void {
  const body = sanitizePasteText(text)
  const buffer = pasteBufferName()
  if (pathName === 'local') {
    tmux(localTmuxPasteArgs(SOCKET, session, buffer, enter), body)
    return
  }
  const cmd = remoteTmuxPasteArgs(CONN, '/s.sock', session, buffer, enter).slice(-1)[0]
  execFileSync('/bin/sh', ['-c', cmd], {
    env: { PATH: `${binDir}:/usr/bin:/bin`, HOME: work },
    input: body,
    encoding: 'utf8'
  })
}

const suite = TMUX ? describe : describe.skip
const PATHS: Array<'local' | 'ssh'> = ['local', 'ssh']

suite('REAL tmux: the version floor is real, and paste-buffer -p removes it', () => {
  it('MEASURED: `#{bracket_paste_flag}` is EMPTY on this tmux even for a pane that DID request it', () => {
    // This is the whole bug in one assertion. The app below announces DECSET 2004; the format the
    // deleted probe read still comes back '' (it first shipped in tmux 3.7), and '' !== '1', so
    // the old code concluded "not paste-aware" and mangled the write.
    const out = recorderPane('nt-floor', 'aware')
    expect(fs.existsSync(`${out}.ready`)).toBe(true)
    const flag = tmux(['-L', SOCKET, 'display-message', '-p', '-t', 'nt-floor', '#{bracket_paste_flag}'])
    const version = tmux(['-V']).trim()
    if (/tmux (3\.[7-9]|[4-9]\.)/.test(version)) {
      // On a host that DOES have 3.7+, the old probe would have worked — the point of the fix is
      // that we no longer care either way, so assert the new path instead of the floor.
      expect(flag.trim()).toBe('1')
    } else {
      expect(flag.trim(), `${version} should not know #{bracket_paste_flag}`).toBe('')
    }
    // …and the new delivery frames it regardless of what that format said.
    send('local', 'nt-floor', 'a\nb')
    expect(drain('nt-floor', out)).toBe(`${START}a\nb${END}\r`)
  })

  it('CONTROL: the pre-fix delivery mangles the very same write into raw newlines', () => {
    // The legacy two-step, reproduced: `send-keys -l --` then `send-keys Enter`, which is what the
    // shipped code ran once the probe above answered ''. If this ever stops producing unframed
    // newlines, the test above is not measuring a fix.
    const out = recorderPane('nt-legacy', 'aware')
    tmux(['-L', SOCKET, 'send-keys', '-t', 'nt-legacy', '-l', '--', 'a\nb'])
    tmux(['-L', SOCKET, 'send-keys', '-t', 'nt-legacy', 'Enter'])
    expect(drain('nt-legacy', out)).toBe('a\nb\r')
  })
})

suite('REAL tmux: tmux decides the framing from the pane, on both paths', () => {
  for (const p of PATHS) {
    it(`${p}: a pane whose app REQUESTED bracketed paste gets a framed multi-line write`, () => {
      const out = recorderPane(`nt-aw-${p}`, 'aware')
      send(p, `nt-aw-${p}`, 'line1\nline2\nline3')
      expect(drain(`nt-aw-${p}`, out)).toBe(`${START}line1\nline2\nline3${END}\r`)
    })

    it(`${p}: a pane whose app did NOT request it gets the legacy bytes, unframed and unchanged`, () => {
      // Not a regression to guard against — a deliberate non-change. An app that never asked for
      // bracketed paste must keep receiving exactly what it received before this PR.
      const out = recorderPane(`nt-un-${p}`, 'unaware')
      send(p, `nt-un-${p}`, 'line1\nline2\nline3')
      expect(drain(`nt-un-${p}`, out)).toBe('line1\nline2\nline3\r')
    })

    it(`${p}: enter:false (dictation insert) sends the frame and NO submit`, () => {
      const out = recorderPane(`nt-ne-${p}`, 'aware')
      send(p, `nt-ne-${p}`, 'draft me', false)
      expect(drain(`nt-ne-${p}`, out)).toBe(`${START}draft me${END}`)
    })

    it(`${p}: an empty payload with enter still submits (and never silently drops the Enter)`, () => {
      // `load-buffer -` given zero bytes creates NO buffer, so a naive implementation's
      // `paste-buffer` fails and tmux abandons the rest of the command list — Enter included.
      const out = recorderPane(`nt-mt-${p}`, 'aware')
      if (p === 'local') {
        tmux(['-L', SOCKET, 'send-keys', '-t', `nt-mt-${p}`, 'Enter'])
      } else {
        const cmd = remoteTmuxEnterArgs(CONN, '/s.sock', `nt-mt-${p}`).slice(-1)[0]
        execFileSync('/bin/sh', ['-c', cmd], { env: { PATH: `${binDir}:/usr/bin:/bin` } })
      }
      expect(drain(`nt-mt-${p}`, out)).toBe('\r')
    })
  }

  it('CONTROL: the naive empty-payload delivery loses the Enter entirely', () => {
    const out = recorderPane('nt-mt-ctl', 'aware')
    const buffer = pasteBufferName()
    // Same argv the non-empty case uses, but with nothing on stdin.
    try {
      tmux(localTmuxPasteArgs(SOCKET, 'nt-mt-ctl', buffer, true), '')
    } catch {
      // tmux reports "no buffer …" — the point is what did NOT reach the pane
    }
    expect(drain('nt-mt-ctl', out), 'the empty-payload special case is no longer needed').toBe('')
  })

  it('the two paths are byte-identical for the same payload', () => {
    const a = recorderPane('nt-par-l', 'aware')
    const b = recorderPane('nt-par-s', 'aware')
    const text = "mixed 'quotes' $HOME `id` #hash;\nsecond line\tand a tab"
    send('local', 'nt-par-l', text)
    send('ssh', 'nt-par-s', text)
    expect(drain('nt-par-s', b)).toBe(drain('nt-par-l', a))
  })

  it('a pane in a session that is NOT the current one, with no client attached, is framed too', () => {
    // The everyday shape: nodeterm's tmux server holds one session per node, nothing is attached,
    // and the write is aimed at a session that is not the server's most-recent one. Nothing in the
    // delivery may depend on the target being "current" — the deleted `#{bracket_paste_flag}`
    // probe and the paste both resolve their own target, and only one of them is still ours.
    const out = recorderPane('nt-other', 'aware')
    const decoy = recorderPane('nt-decoy', 'aware') // created last ⇒ tmux's current session
    send('local', 'nt-other', 'x\ny')
    expect(drain('nt-other', out)).toBe(`${START}x\ny${END}\r`)
    expect(fs.readFileSync(decoy, 'utf8'), 'the write leaked into the current session').toBe('')
  })
})

suite('REAL tmux: copy mode', () => {
  for (const p of PATHS) {
    it(`${p}: a pane the user scrolled back in still receives a FRAMED write, and the submit`, () => {
      const out = recorderPane(`nt-cm-${p}`, 'aware')
      tmux(['-L', SOCKET, 'copy-mode', '-t', `nt-cm-${p}`])
      expect(tmux(['-L', SOCKET, 'display-message', '-p', '-t', `nt-cm-${p}`, '#{pane_in_mode}']).trim()).toBe('1')
      send(p, `nt-cm-${p}`, 'a\nb')
      expect(drain(`nt-cm-${p}`, out)).toBe(`${START}a\nb${END}\r`)
      // The user-visible cost, asserted rather than described: they are back at the live view.
      expect(tmux(['-L', SOCKET, 'display-message', '-p', '-t', `nt-cm-${p}`, '#{pane_in_mode}']).trim()).toBe('0')
    })
  }

  it('CONTROL: without the gated cancel, copy mode unframes the paste', () => {
    // Why the cancel is in the command list at all. `paste-buffer -p` consults the copy-mode
    // SCREEN, not the application, so a wheel scroll silently restores the one-turn-per-line bug.
    const out = recorderPane('nt-cm-ctl', 'aware')
    tmux(['-L', SOCKET, 'copy-mode', '-t', 'nt-cm-ctl'])
    expect(tmux(['-L', SOCKET, 'display-message', '-p', '-t', 'nt-cm-ctl', '#{pane_in_mode}']).trim()).toBe('1')
    const buffer = pasteBufferName()
    tmux(
      ['-L', SOCKET, 'load-buffer', '-b', buffer, '-', ';', 'paste-buffer', '-d', '-p', '-r', '-b', buffer, '-t', 'nt-cm-ctl', ';', 'send-keys', '-t', 'nt-cm-ctl', 'Enter'],
      'a\nb'
    )
    // The Enter never reached the app either: in copy mode it is `copy-selection-and-cancel`,
    // which is also why the pane is out of copy mode again by now.
    expect(drain('nt-cm-ctl', out), 'copy mode no longer unframes — the if-shell gate is dead weight').toBe('a\nb')
  })

  it('CONTROL: an UNGATED cancel breaks every ordinary write — which is why `if-shell -F` gates it', () => {
    // Measured: `send-keys -X cancel` against a pane not in a mode exits 1 and tmux ABANDONS the
    // rest of the command list. Prepending it unconditionally would have replaced a mangle with a
    // total failure.
    const out = recorderPane('nt-nc-ctl', 'aware')
    const buffer = pasteBufferName()
    expect(() =>
      tmux(
        ['-L', SOCKET, 'send-keys', '-t', 'nt-nc-ctl', '-X', 'cancel', ';', 'load-buffer', '-b', buffer, '-', ';', 'paste-buffer', '-d', '-p', '-r', '-b', buffer, '-t', 'nt-nc-ctl'],
        'a\nb'
      )
    ).toThrow()
    expect(drain('nt-nc-ctl', out)).toBe('')
  })

  it('CONTROL: today, a write into a scrolled-back pane delivers NO TEXT — at best nothing, at worst a bare submit', () => {
    // The honest baseline for the user-visible cost above: cancelling copy mode is not a
    // regression against a working behaviour, it replaces a silent drop of the whole payload.
    // The copy-mode key table eats the literal send; what happens to the trailing Enter depends
    // on whether the payload's own `\n` already cancelled the mode, so the ROBUST property — and
    // the alarming one — is that the text never lands while a bare Enter still can, i.e. the
    // delivery can submit whatever the human had composed and type none of the payload.
    // Exit status is deliberately not asserted: a tmux server shared by several clients hands a
    // failing command's error to whichever client is listening (observed in this very file), so
    // the bytes are the only reliable witness. Measured in an isolated shell, both sends exit 0
    // and `sendText` therefore returns TRUE.
    const out = recorderPane('nt-cm-legacy', 'aware')
    tmux(['-L', SOCKET, 'copy-mode', '-t', 'nt-cm-legacy'])
    expect(tmux(['-L', SOCKET, 'display-message', '-p', '-t', 'nt-cm-legacy', '#{pane_in_mode}']).trim()).toBe('1')
    tryTmux(['-L', SOCKET, 'send-keys', '-t', 'nt-cm-legacy', '-l', '--', 'a\nb'])
    tryTmux(['-L', SOCKET, 'send-keys', '-t', 'nt-cm-legacy', 'Enter'])
    tryTmux(['-L', SOCKET, 'send-keys', '-t', 'nt-cm-legacy', '-X', 'cancel'])
    const got = drain('nt-cm-legacy', out)
    expect(got, 'the legacy path now reaches a scrolled-back pane').not.toMatch(/[ab]/)
    expect(got.replace(/\r/g, '')).toBe('')
  })
})

suite('REAL tmux: the payload does not ride a command line', () => {
  const BIG = 'A'.repeat(300_000)

  it('CONTROL: the same payload as ONE argument is "Argument list too long"', () => {
    // MAX_ARG_STRLEN is 128 KB per argument, far below `getconf ARG_MAX`. This is why the text
    // goes over stdin and not through `set-buffer --`.
    expect(() => tmux(['-L', SOCKET, 'set-buffer', '-b', 'nt-argmax', '--', BIG])).toThrow(
      /too long|E2BIG|ENAMETOOLONG/i
    )
  })

  for (const p of PATHS) {
    it(`${p}: 300 KB over stdin arrives complete and framed`, () => {
      const out = recorderPane(`nt-big-${p}`, 'aware')
      send(p, `nt-big-${p}`, BIG, false)
      const got = drain(`nt-big-${p}`, out)
      expect(got.length).toBe(BIG.length + START.length + END.length)
      expect(got.startsWith(START) && got.endsWith(END)).toBe(true)
    })
  }
})

suite("REAL tmux: the delivery does not disturb the user's own tmux state", () => {
  it("leaves the numbered buffer stack untouched and deletes its own private buffer", () => {
    const out = recorderPane('nt-buf', 'aware')
    tmux(['-L', SOCKET, 'set-buffer', 'USER-A'])
    tmux(['-L', SOCKET, 'set-buffer', 'USER-B'])
    const before = tmux(['-L', SOCKET, 'list-buffers'])
    send('local', 'nt-buf', 'hello')
    drain('nt-buf', out)
    expect(tmux(['-L', SOCKET, 'list-buffers'])).toBe(before)
  })

  it('two concurrent deliveries do not swap payloads (the buffer name is per-call)', () => {
    // tmux interleaves command lists from different clients, so a shared buffer name is a real
    // race: the second `load-buffer` overwrites the first before its `paste-buffer` runs.
    const a = recorderPane('nt-race-a', 'aware')
    const b = recorderPane('nt-race-b', 'aware')
    const ba = pasteBufferName()
    const bb = pasteBufferName()
    expect(ba).not.toBe(bb)
    tmux(['-L', SOCKET, 'load-buffer', '-b', ba, '-'], 'AAA')
    tmux(['-L', SOCKET, 'load-buffer', '-b', bb, '-'], 'BBB')
    tmux(['-L', SOCKET, 'paste-buffer', '-d', '-p', '-r', '-b', ba, '-t', 'nt-race-a'])
    tmux(['-L', SOCKET, 'paste-buffer', '-d', '-p', '-r', '-b', bb, '-t', 'nt-race-b'])
    expect(drain('nt-race-a', a)).toBe(`${START}AAA${END}`)
    expect(drain('nt-race-b', b)).toBe(`${START}BBB${END}`)
  })

  it('CONTROL: with ONE shared buffer name the same interleaving crosses the payloads', () => {
    const a = recorderPane('nt-race2-a', 'aware')
    const b = recorderPane('nt-race2-b', 'aware')
    const shared = pasteBufferName()
    tmux(['-L', SOCKET, 'load-buffer', '-b', shared, '-'], 'AAA')
    tmux(['-L', SOCKET, 'load-buffer', '-b', shared, '-'], 'BBB')
    tmux(['-L', SOCKET, 'paste-buffer', '-p', '-r', '-b', shared, '-t', 'nt-race2-a'])
    tmux(['-L', SOCKET, 'paste-buffer', '-d', '-p', '-r', '-b', shared, '-t', 'nt-race2-b'])
    expect(drain('nt-race2-a', a), 'a shared buffer name is no longer a race').toBe(`${START}BBB${END}`)
    expect(drain('nt-race2-b', b)).toBe(`${START}BBB${END}`)
  })
})

suite('REAL tmux: -r is what keeps a newline a newline', () => {
  it('CONTROL: without -r, tmux rewrites every \\n to \\r — one submit per line, the bug itself', () => {
    const out = recorderPane('nt-nor', 'aware')
    const buffer = pasteBufferName()
    tmux(['-L', SOCKET, 'load-buffer', '-b', buffer, '-', ';', 'paste-buffer', '-d', '-p', '-b', buffer, '-t', 'nt-nor'], 'a\nb')
    expect(drain('nt-nor', out)).toBe(`${START}a\rb${END}`)
  })
})

// ── SECURITY: a real bash, a real readline, and a filesystem verdict ────────────────────────────
//
// The frame is a promise to somebody else's parser that everything between the markers is CONTENT.
// tmux inserting the markers changes who writes them, not that promise — a payload carrying
// `ESC[201~` would still close the frame early and turn its tail into KEY INPUT. `sanitizePasteText`
// is untouched by this PR and this is where that is proven for the new delivery.
function bashPane(session: string): string {
  const marker = path.join(work, `${session}-ready`)
  try {
    execFileSync(TMUX as string, ['-L', SOCKET, 'kill-session', '-t', `=${session}`], {
      stdio: 'ignore',
      env: env()
    })
  } catch {
    // none yet
  }
  tmux([
    '-L',
    SOCKET,
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '200',
    '-y',
    '40',
    '-e',
    'HISTFILE=/dev/null',
    '-c',
    work,
    'bash --norc --noprofile -i'
  ])
  waitFor(() => tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', session]).trim().length > 0, 'bash prompt')
  return marker
}

/** ctrl-c, then a sentinel command: once its file exists, everything queued before it has run. */
function bashDrain(session: string, tag: string): void {
  const sentinel = path.join(work, `sent-${tag}`)
  tmux(['-L', SOCKET, 'send-keys', '-t', session, 'C-c'])
  tmux(['-L', SOCKET, 'send-keys', '-t', session, '-l', '--', `touch ${sentinel}`])
  tmux(['-L', SOCKET, 'send-keys', '-t', session, 'Enter'])
  waitFor(() => fs.existsSync(sentinel), `bash to reach the ${tag} sentinel`)
}

suite('REAL bash through REAL tmux: the payload cannot become key input', () => {
  for (const p of PATHS) {
    it(`${p}: a payload closing the frame early does NOT execute its tail`, () => {
      bashPane(`nt-sec-${p}`)
      const m = path.join(work, `pwn-${p}`)
      send(p, `nt-sec-${p}`, `hello${END}\rtouch ${m}\r`, false)
      bashDrain(`nt-sec-${p}`, `nt-sec-${p}`)
      expect(fs.existsSync(m), 'the payload ESCAPED the frame and ran').toBe(false)
      // and the text still arrived as content: ESC has no glyph, its printable tail survives
      expect(tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', `nt-sec-${p}`])).toContain('hello[201~')
    })

    it(`${p}: an early close plus ctrl-u does not wipe the line and run a command`, () => {
      bashPane(`nt-sec2-${p}`)
      const m = path.join(work, `pwn2-${p}`)
      send(p, `nt-sec2-${p}`, `SAFE${END}\x15touch ${m} #`, true)
      bashDrain(`nt-sec2-${p}`, `nt-sec2-${p}`)
      expect(fs.existsSync(m), 'ctrl-u was read as a KEY').toBe(false)
    })
  }

  it('CONTROL: the same attack DOES run when the payload is not sanitized', () => {
    // Run, not described. If this stops creating the marker the two tests above prove nothing.
    bashPane('nt-sec-ctl')
    const m = path.join(work, 'pwn-ctl')
    const buffer = pasteBufferName()
    tmux(localTmuxPasteArgs(SOCKET, 'nt-sec-ctl', buffer, false), `hello${END}\rtouch ${m}\r`)
    bashDrain('nt-sec-ctl', 'nt-sec-ctl')
    expect(fs.existsSync(m), 'the attack no longer works — these tests are vacuous').toBe(true)
  })
})

suite('the unquoted splices are asserted, not assumed', () => {
  it('refuses a target that this app did not generate (it is spliced into a tmux command string)', () => {
    for (const bad of ['nt-x; kill-server', 'nt-x y', "nt-x'", '#{pane_id}', '', 'other-session']) {
      expect(() => localTmuxPasteArgs('s', bad, pasteBufferName(), true)).toThrow(/unsafe tmux paste target/)
      expect(() => remoteTmuxPasteArgs(CONN, '/s.sock', bad, pasteBufferName(), true)).toThrow(
        /unsafe tmux paste target/
      )
    }
  })
  it('refuses a buffer name that is not one of ours', () => {
    expect(() => localTmuxPasteArgs('s', 'nt-x', 'buffer0', true)).toThrow(/unsafe tmux buffer name/)
    expect(() => localTmuxPasteArgs('s', 'nt-x', 'nt-paste-a b', true)).toThrow(/unsafe tmux buffer name/)
  })
  it('accepts every name `sessionName` can produce', () => {
    expect(() => localTmuxPasteArgs('s', 'nt-term-mabc-3', pasteBufferName(), true)).not.toThrow()
  })
})
