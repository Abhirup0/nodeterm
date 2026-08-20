import { describe, it, expect } from 'vitest'
import { SUN_PATH_MAX, tmuxSocketPath, pickTmuxTmpdirBase } from './tmux-test-socket'

// The real macOS per-user temp root, measured on the machine where the realtmux suite broke.
// `os.tmpdir()` reports it without the `/private` prefix; tmux resolves the symlink before it
// binds, which is where the 8 characters that overflow the sockaddr come from.
const MAC_TMP = '/private/var/folders/_f/sgpx16sd7z79ycmkyylw5tg40000gn/T'

describe('tmuxSocketPath', () => {
  it('is where tmux binds for `-L <socket>` under a given TMUX_TMPDIR', () => {
    expect(tmuxSocketPath('/tmp/nts-abc123', 501, 'sock')).toBe('/tmp/nts-abc123/tmux-501/sock')
  })
})

describe('pickTmuxTmpdirBase', () => {
  it('keeps the first base that fits — the caller orders them by preference', () => {
    expect(pickTmuxTmpdirBase([MAC_TMP, '/tmp'], 501, 'sock', 'p-')).toBe(MAC_TMP)
  })

  it('skips a base whose socket path would not fit and takes the next', () => {
    // This is the regression: the real prefix and socket name from
    // local-send-keys.realtmux.test.ts, which came to 106 characters under the macOS temp root
    // and failed as `error connecting to …: File name too long`.
    const base = pickTmuxTmpdirBase([MAC_TMP, '/tmp'], 501, 'nt-sendkeys-test-38663', 'ntsendkeys-')
    expect(base).toBe('/tmp')
  })

  it('accounts for the six random characters mkdtemp appends to the prefix', () => {
    // A prefix landing EXACTLY on the limit before mkdtemp grows it, so the only thing that can
    // make this base unusable is the six characters — nothing else in the arithmetic.
    const uid = 501
    const socket = 'sock'
    const overhead = `${MAC_TMP}/`.length + `/tmux-${uid}/${socket}`.length
    const prefix = 'x'.repeat(SUN_PATH_MAX - overhead)
    expect(tmuxSocketPath(`${MAC_TMP}/${prefix}`, uid, socket).length).toBe(SUN_PATH_MAX)
    expect(pickTmuxTmpdirBase([MAC_TMP], uid, socket, prefix)).toBeNull()
  })

  it('is null when no base fits — a caller must not silently bind a truncated path', () => {
    expect(pickTmuxTmpdirBase([MAC_TMP], 501, 'x'.repeat(200), 'p-')).toBeNull()
  })
})
