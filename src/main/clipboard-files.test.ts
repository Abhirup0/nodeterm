import { describe, expect, it, vi } from 'vitest'
import {
  FILE_LIST_PASTEBOARD_TYPE,
  fileListPropertyList,
  writeFilesToClipboard,
  type FileClipboardDependencies
} from './clipboard-files'

const dependencies = (overrides: Partial<FileClipboardDependencies> = {}): FileClipboardDependencies => ({
  platform: 'darwin',
  isFile: () => true,
  writeBuffer: vi.fn(),
  ...overrides
})

describe('writeFilesToClipboard', () => {
  it('writes unique existing absolute files as a macOS filename pasteboard list', () => {
    const deps = dependencies()
    expect(writeFilesToClipboard(['/tmp/a & b.png', '/tmp/a & b.png'], deps)).toBe(true)
    expect(deps.writeBuffer).toHaveBeenCalledOnce()
    const [format, buffer] = vi.mocked(deps.writeBuffer).mock.calls[0]
    expect(format).toBe(FILE_LIST_PASTEBOARD_TYPE)
    expect(buffer.toString()).toContain('<string>/tmp/a &amp; b.png</string>')
    expect(buffer.toString().match(/<string>/g)).toHaveLength(1)
  })

  it('rejects unsupported platforms and any selection containing an invalid file', () => {
    expect(writeFilesToClipboard(['/tmp/a'], dependencies({ platform: 'linux' }))).toBe(false)
    expect(writeFilesToClipboard(['/tmp/a'], dependencies({ isFile: () => false }))).toBe(false)
    expect(writeFilesToClipboard(['/tmp/a', 'relative'], dependencies())).toBe(false)
    expect(writeFilesToClipboard('not-an-array', dependencies())).toBe(false)
  })

  it('fails closed when the OS clipboard write fails', () => {
    expect(
      writeFilesToClipboard(
        ['/tmp/a'],
        dependencies({
          writeBuffer: () => {
            throw new Error('clipboard unavailable')
          }
        })
      )
    ).toBe(false)
  })
})

describe('fileListPropertyList', () => {
  it('escapes every XML-significant path character', () => {
    expect(fileListPropertyList([`/tmp/<a>\"'&`]).toString()).toContain(
      '&lt;a&gt;&quot;&apos;&amp;'
    )
  })
})
