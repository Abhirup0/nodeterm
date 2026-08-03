import { describe, expect, it } from 'vitest'
import {
  CELL_STRIDE,
  FLAG_BOLD,
  FLAG_SELECTED,
  packColor,
  readCell,
  unpackColor,
  writeCell
} from './cells'

describe('glyphgrid cells', () => {
  it('packColor/unpackColor round-trip all channels', () => {
    const c = packColor(0x12, 0x34, 0x56, 0xff)
    expect(unpackColor(c)).toEqual({ r: 0x12, g: 0x34, b: 0x56, a: 0xff })
  })

  it('writeCell/readCell round-trip through a shared buffer', () => {
    const buf = new Uint32Array(3 * CELL_STRIDE)
    writeCell(buf, 2, 4242, packColor(1, 2, 3, 255), packColor(9, 8, 7, 255), FLAG_BOLD | FLAG_SELECTED)
    const cell = readCell(buf, 2)
    expect(cell.glyph).toBe(4242)
    expect(cell.flags).toBe(FLAG_BOLD | FLAG_SELECTED)
    expect(unpackColor(cell.fg)).toEqual({ r: 1, g: 2, b: 3, a: 255 })
    // Neighboring cells untouched:
    expect(readCell(buf, 1)).toEqual({ glyph: 0, fg: 0, bg: 0, flags: 0 })
  })

  it('a packed color equals the lane it was written to, even with alpha >= 128', () => {
    // `0xff << 24` is negative in JS, so an unguarded packColor returns a signed int while the
    // Uint32Array lane reads back unsigned — the two would never compare equal, and a
    // dirty-check comparing a fresh packColor() against readCell() would fire forever.
    const opaque = packColor(1, 2, 3, 255)
    expect(opaque).toBeGreaterThan(0)

    const buf = new Uint32Array(2 * CELL_STRIDE)
    writeCell(buf, 0, 65, opaque, packColor(9, 8, 7, 200), FLAG_BOLD)
    const cell = readCell(buf, 0)
    expect(cell.fg).toBe(opaque)
    expect(cell.bg).toBe(packColor(9, 8, 7, 200))
  })
})
