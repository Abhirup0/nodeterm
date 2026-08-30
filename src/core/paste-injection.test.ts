import { describe, it, expect } from 'vitest'
import { sanitizePasteText, PASTE_START, PASTE_END } from './paste-injection'

const ESC = '\x1b'
/** The 8-bit C1 form of CSI — no glyph, same structural meaning to an 8-bit-clean parser. */
const C1_CSI = ''

/**
 * SECURITY — a sanitized payload cannot express paste structure.
 *
 * The frame itself is tmux's now (`paste-buffer -p` — the JS framer `bracketedInjection` is
 * deleted, see the tombstone in paste-injection.ts), but the invariant is unchanged: everything
 * that goes INTO a paste buffer went through `sanitizePasteText` first, so no byte of a payload
 * can close, reopen or nest the frame tmux draws around it. Every case below reduces to: ZERO
 * ESC/C1 bytes survive. A parser cannot see structure in bytes that contain none.
 */
describe('sanitizePasteText: a payload cannot escape its frame', () => {
  const escCount = (s: string): number => s.split(ESC).length - 1

  const ATTACKS: Record<string, string> = {
    // The escape itself: end the paste, then submit whatever follows as keys.
    endMarker: `hello${PASTE_END}\rrm -rf ~\r`,
    // …with a control KEY rather than a command, so the damage needs no newline.
    endMarkerThenCtrlU: `SAFE${PASTE_END}\x15echo pwned`,
    // A second paste-START: apps that track "in a paste" as a boolean can re-open or nest.
    startMarker: `hello${PASTE_START}world`,
    // Both, in the order that first closes then re-opens — the frame looks balanced again.
    closeThenReopen: `a${PASTE_END}b${PASTE_START}c`,
    // A bare ESC at the very END, positioned to join a marker's own ESC that could follow it.
    trailingEsc: `hello${ESC}`,
    // A partial CSI at the end — the same trick, one byte further along.
    trailingPartialCsi: `hello${ESC}[20`,
    // The 8-bit C1 form of CSI.
    c1Csi: `hello${C1_CSI}201~\rid\r`,
    // A payload that is nothing but the marker.
    markerOnly: PASTE_END,
    // Repeated, so a single-shot replace cannot be mistaken for a fix.
    repeated: `${PASTE_END}${PASTE_END}${PASTE_END}`,
    // Overlapping: a naive non-global replace leaves a whole marker behind.
    overlapping: `${ESC}${ESC}[[200~201~${PASTE_END}`
  }

  for (const [name, payload] of Object.entries(ATTACKS)) {
    it(`${name}: no ESC or C1 byte survives`, () => {
      const body = sanitizePasteText(payload)
      expect(escCount(body), 'an ESC byte from the payload survived').toBe(0)
      expect(body).not.toContain(C1_CSI)
      expect(body).not.toContain(PASTE_START)
      expect(body).not.toContain(PASTE_END)
    })
  }
})

describe('sanitizePasteText', () => {
  it('leaves ordinary text — including newlines and tabs — byte-for-byte', () => {
    const text = 'line one\nline two\r\n\tindented — ünïcode 🎉 $(id) `id` \'quotes\''
    expect(sanitizePasteText(text)).toBe(text)
  })
  it('keeps every PRINTABLE character of an escape sequence, dropping only the invisible ESC', () => {
    // A pasted transcript that documents bracketed paste still reads.
    expect(sanitizePasteText(`start ${PASTE_START} end ${PASTE_END}`)).toBe('start [200~ end [201~')
    expect(sanitizePasteText(`${ESC}[31mred${ESC}[0m`)).toBe('[31mred[0m')
  })
  it('is idempotent', () => {
    const once = sanitizePasteText(`a${PASTE_END}b`)
    expect(sanitizePasteText(once)).toBe(once)
  })
})
