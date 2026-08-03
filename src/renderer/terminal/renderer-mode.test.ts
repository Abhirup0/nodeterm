import { describe, expect, it } from 'vitest'
import { applyRendererMode } from './renderer-mode'

function record(): { calls: string[]; sinks: Parameters<typeof applyRendererMode>[1] } {
  const calls: string[] = []
  return {
    calls,
    sinks: {
      setWebglEnabled: (on) => calls.push(`webgl:${on}`),
      setSharedEnabled: (on) => calls.push(`shared:${on}`)
    }
  }
}

describe('applyRendererMode', () => {
  it("'webgl' runs the per-terminal budget and nothing else", () => {
    const { calls, sinks } = record()
    applyRendererMode('webgl', sinks)
    expect(calls).toEqual(['shared:false', 'webgl:true'])
  })

  it("'dom' turns both renderers off", () => {
    const { calls, sinks } = record()
    applyRendererMode('dom', sinks)
    expect(calls).toEqual(['shared:false', 'webgl:false'])
  })

  it("'shared' takes the per-terminal budget down BEFORE the shared canvas comes up", () => {
    // Order is the contract, not an accident. Enabling the shared canvas is what makes every
    // mounted terminal hand its render service to the glyph addon; a terminal that still held a
    // budgeted WebGL context at that moment would end up with two renderers on one xterm (the
    // addon's setRenderer silently disposes the other one, leaving the coordinator accounting for
    // a context nobody paints with). Reclaiming first means every xterm is on its DOM renderer
    // when the swap happens.
    const { calls, sinks } = record()
    applyRendererMode('shared', sinks)
    expect(calls).toEqual(['webgl:false', 'shared:true'])
  })

  it('LEAVING shared tears the shared canvas down BEFORE the budget may grant again', () => {
    // The mirror image: the shared store's disable synchronously notifies every registered grid,
    // which detaches the addon and puts xterm back on its DOM renderer. Only then may the budget
    // start handing out per-terminal contexts.
    const { calls, sinks } = record()
    applyRendererMode('webgl', sinks)
    expect(calls.indexOf('shared:false')).toBeLessThan(calls.indexOf('webgl:true'))
  })
})
