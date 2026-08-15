import { describe, it, expect } from 'vitest'
import { planRemoteWorkspacePoll } from './remote-workspace-poll'

const plan = (
  ids: string[],
  opts: { refs?: string[]; busy?: string[]; sockets?: string[] } = {}
): ReturnType<typeof planRemoteWorkspacePoll> =>
  planRemoteWorkspacePoll({
    sshProjectIds: ids,
    hasLiveRef: (id) => (opts.refs ?? []).includes(id),
    busy: (id) => (opts.busy ?? []).includes(id),
    hasControlSocket: (id) => (opts.sockets ?? []).includes(id)
  })

describe('planRemoteWorkspacePoll', () => {
  it('polls every connected project, active tab or not', () => {
    expect(plan(['a', 'b'], { refs: ['a', 'b'] })).toEqual({ poll: ['a', 'b'], adopt: [] })
  })

  it('skips a project whose read is still in flight', () => {
    expect(plan(['a', 'b'], { refs: ['a', 'b'], busy: ['a'] }).poll).toEqual(['b'])
  })

  it('adopts a running master for a project this run never connected', () => {
    // The field failure: an SSH project sitting in a background tab (or untouched since launch) has
    // no ref, so it was skipped forever and the session the phone registered into it stayed
    // invisible until the user clicked that tab.
    expect(plan(['a'], { sockets: ['a'] })).toEqual({ poll: [], adopt: ['a'] })
  })

  it('NEVER offers a project with no control socket — a poll must not dial a host', () => {
    // Dialing would be a real TCP + auth per host per tick, and can raise a passphrase prompt.
    expect(plan(['a', 'b'], { sockets: ['b'] })).toEqual({ poll: [], adopt: ['b'] })
  })

  it('does not re-attempt an adoption that is still running', () => {
    expect(plan(['a'], { sockets: ['a'], busy: ['a'] })).toEqual({ poll: [], adopt: [] })
  })

  it('never puts one project in both lists', () => {
    const p = plan(['a'], { refs: ['a'], sockets: ['a'] })
    expect(p).toEqual({ poll: ['a'], adopt: [] })
  })

  it('is empty for a workspace with no ssh projects', () => {
    expect(plan([])).toEqual({ poll: [], adopt: [] })
  })
})
