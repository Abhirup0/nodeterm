import { describe, it, expect } from 'vitest'
import {
  bracketedInjection,
  sanitizePasteText,
  PASTE_START,
  PASTE_END
} from './paste-injection'

const ESC = '\x1b'
/** The 8-bit C1 form of CSI — no glyph, same structural meaning to an 8-bit-clean parser. */
const C1_CSI = '\u009b'

describe('bracketedInjection', () => {
  it('frames the text in paste markers with the Enter in the same body', () => {
    expect(bracketedInjection('hello', true)).toBe(`${PASTE_START}hello${PASTE_END}\r`)
  })
  it('omits the Enter when not requested (dictation insert)', () => {
    expect(bracketedInjection('hello', false)).toBe(`${PASTE_START}hello${PASTE_END}`)
  })
  it('keeps multiline text inside one paste frame — newlines are content, not submits', () => {
    const body = bracketedInjection('line one\nline two', true)
    expect(body).toBe(`${PASTE_START}line one\nline two${PASTE_END}\r`)
    expect(body.indexOf('\r')).toBe(body.length - 1)
  })
})

/**
 * SECURITY — the payload cannot express paste structure.
 *
 * The invariant every case below reduces to: the produced body contains exactly TWO ESC bytes,
 * the frame's own, at its two ends. A parser cannot see structure in bytes that contain none.
 */
describe('bracketedInjection: a payload cannot escape its frame', () => {
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
    // A bare ESC at the very END, positioned to join the marker's own ESC that follows it.
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
    for (const enter of [true, false]) {
      it(`${name} (enter=${enter}): the body carries only the frame's own escapes`, () => {
        const body = bracketedInjection(payload, enter)
        expect(escCount(body), 'an ESC byte from the payload survived').toBe(2)
        expect(body.startsWith(PASTE_START)).toBe(true)
        // Exactly one end marker, and it closes the frame.
        expect(body.split(PASTE_END)).toHaveLength(2)
        expect(body.endsWith(enter ? `${PASTE_END}\r` : PASTE_END)).toBe(true)
        // No paste-start other than the frame's own.
        expect(body.indexOf(PASTE_START, 1)).toBe(-1)
        expect(body).not.toContain(C1_CSI)
        // The last byte before the closing marker is never an ESC that could swallow it.
        const inner = body.slice(PASTE_START.length, body.length - (enter ? 1 : 0) - PASTE_END.length)
        expect(inner.endsWith(ESC)).toBe(false)
      })
    }
  }

  it('with enter, the ONLY \\r outside the payload is the final submit', () => {
    const body = bracketedInjection(`hi${PASTE_END}\rid`, true)
    // The payload's own \r stays inside the frame as content; the submit is the last byte.
    expect(body).toBe(`${PASTE_START}hi[201~\rid${PASTE_END}\r`)
    expect(body.lastIndexOf('\r')).toBe(body.length - 1)
  })
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
