import { describe, it, expect } from 'vitest'

import {
  LEAD_PANE_GUARD_GAP,
  LEAD_PANE_WIDTH_DEFAULT,
  LEAD_PANE_WIDTH_MAX,
  LEAD_PANE_WIDTH_MIN,
  leadPaneHookLines,
  sanitizeLeadPaneWidth
} from './tmux-lead-pane'

describe('sanitizeLeadPaneWidth', () => {
  it('off (0 / negative / non-number / non-finite) sanitizes to 0 — the pre-feature conf', () => {
    // settings.json is hand-editable JSON; anything that is not an unambiguous "on" must degrade
    // to the bare conf, never to a guessed width (same rule as permissionModeFlag).
    expect(sanitizeLeadPaneWidth(0)).toBe(0)
    expect(sanitizeLeadPaneWidth(-5)).toBe(0)
    expect(sanitizeLeadPaneWidth('72')).toBe(0)
    expect(sanitizeLeadPaneWidth(NaN)).toBe(0)
    expect(sanitizeLeadPaneWidth(Infinity)).toBe(0)
    expect(sanitizeLeadPaneWidth(undefined)).toBe(0)
    expect(sanitizeLeadPaneWidth(null)).toBe(0)
    // Forged-object values (the `constructor` class of attack) are not numbers → off.
    expect(sanitizeLeadPaneWidth({ valueOf: () => 72 })).toBe(0)
  })

  it('positive values clamp into [40, 90]; fractions round', () => {
    expect(sanitizeLeadPaneWidth(72)).toBe(72)
    expect(sanitizeLeadPaneWidth(10)).toBe(LEAD_PANE_WIDTH_MIN)
    expect(sanitizeLeadPaneWidth(99)).toBe(LEAD_PANE_WIDTH_MAX)
    expect(sanitizeLeadPaneWidth(72.4)).toBe(72)
  })

  it('the guard stays strictly below the target for every allowed width — the self-termination invariant', () => {
    // The after-resize-pane hook resizes the lead to the target, which fires the hook again; the
    // chain stops ONLY because the lead is then >= the guard threshold. guard >= target would loop.
    for (let w = LEAD_PANE_WIDTH_MIN; w <= LEAD_PANE_WIDTH_MAX; w++) {
      expect(w - LEAD_PANE_GUARD_GAP).toBeGreaterThan(0)
      expect(w - LEAD_PANE_GUARD_GAP).toBeLessThan(w)
    }
  })
})

describe('leadPaneHookLines', () => {
  it("off ⇒ '' exactly — the interpolation site adds nothing, so the conf stays byte-identical", () => {
    expect(leadPaneHookLines(0)).toBe('')
    expect(leadPaneHookLines(undefined)).toBe('')
    expect(leadPaneHookLines('junk')).toBe('')
  })

  it('emits the reporter-tested guarded hook pair with the width and derived guard interpolated', () => {
    const lines = leadPaneHookLines(LEAD_PANE_WIDTH_DEFAULT)
    // The default (72) must reproduce the issue-#119 recipe's numbers: target 72%, guard 60%
    // (the reporter wrote window_width*6/10; we emit the equivalent *60/100).
    expect(lines).toContain(
      `set-hook -g after-resize-pane "if-shell -F -t '{top-left}' '#{e|<:#{pane_width},#{e|/:#{e|*:#{window_width},60},100}}' { resize-pane -t '{top-left}' -x '72%' }"`
    )
    // NOT the reporter's literal `#{<:...}` here: on tmux 3.4 the plain comparison is a STRING
    // compare (#{<:59,200} = 0 — measured), so the split hook must use the numeric e| form.
    expect(lines).toContain(
      `set-hook -g after-split-window "if-shell -F -t '{top-left}' '#{&&:#{==:#{window_panes},2},#{e|<:#{pane_width},#{window_width}}}' { resize-pane -t '{top-left}' -x '72%' }"`
    )
    // Splices cleanly between conf lines.
    expect(lines.endsWith('\n')).toBe(true)
    expect(lines.startsWith('#')).toBe(true)
  })

  it('a non-default width lands in both the guard and the resize target', () => {
    const lines = leadPaneHookLines(80)
    expect(lines).toContain(`#{e|*:#{window_width},${80 - LEAD_PANE_GUARD_GAP}}`)
    expect(lines).toContain("-x '80%'")
    expect(lines).not.toContain("'72%'")
  })

  it('an out-of-range hand edit emits the clamped width, never the raw value', () => {
    expect(leadPaneHookLines(999)).toContain(`-x '${LEAD_PANE_WIDTH_MAX}%'`)
    expect(leadPaneHookLines(1)).toContain(`-x '${LEAD_PANE_WIDTH_MIN}%'`)
  })
})
