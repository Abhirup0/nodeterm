import type { NodeTerminalApi } from '@shared/types'

// A canvas can mount hundreds of terminals at once. The host platform is immutable for the life of
// one core API, while tmuxStatus() may re-run command discovery when tmux is absent, so coalesce the
// read per API identity instead of turning node mount into hundreds of process probes.
const byApi = new WeakMap<NodeTerminalApi, Promise<string | null>>()

/** `process.platform` of the core that owns `api`, or null when it could not be observed. */
export function hostPlatformFor(api: NodeTerminalApi): Promise<string | null> {
  const cached = byApi.get(api)
  if (cached) return cached
  const read = api.pty.tmuxStatus().then(
    (status) => status.platform,
    () => null
  )
  byApi.set(api, read)
  return read
}
