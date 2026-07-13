// openRelayTab — turn an approved (or approving) relay connection into a project TAB.
//
// docs/remote-sessions.md, Stage 4 Task 6: a remote desktop is a client of the host's core, so it
// opens as an ordinary project tab (not a full-screen overlay). This is the join point that wires
// Task 5's `buildRelayApi` into the 4a session registry:
//   buildRelayApi(id) → createSession('relay', api, label) → a `projects` tab bound to it → active.
//
// TWO obligations this bootstrap owns (both would silently break the tab):
//  • Construction order (relay-api.ts gotcha 2): `buildRelayApi` is called FIRST — its
//    `RelayFrameTransport` registers the one-shot `onApproved` listener BEFORE we await `ready()`.
//    Build it after approval already fired and `ready()` stays pending forever.
//  • ready() can HANG (Task 5 review): `RelayFrameTransport.ready()` resolves only on `onApproved`
//    and NEVER rejects; a socket drop BEFORE the SAS is approved would leave the bootstrap awaiting
//    forever — a dead tab that never errors. So we RACE `ready()` against the connection's real
//    close signal (relayClient.onClosed) plus a timeout backstop, and reject on either.

import type { RelayClientApi } from '@shared/types'
import { buildRelayApi, type RelayApiHandle } from '../bridge/relay-api'
import {
  createSession,
  bindProjectToSession,
  setActiveSession,
  holdSessionTeardown,
  disposeSession,
  getSessionStores,
} from './session'

/** Backstop for a `ready()` that neither approves nor closes (the network vanished without a FIN). */
const APPROVAL_TIMEOUT_MS = 60_000

export interface RelayTabDeps {
  /** The preload relay surface — only `onClosed` is needed here (to catch a pre-approval drop). */
  relayClient: Pick<RelayClientApi, 'onClosed'>
  /** Add a project tab (`useProjects.getState().addProject`) → the new project's id. */
  addProject: (label: string) => { id: string }
  /** Make the new tab active (`useProjects.getState().setActive`). */
  setActiveProject: (projectId: string) => void
  /** TEST SEAM: build the relay api handle. Production omits it → `buildRelayApi`. */
  buildApi?: (connectionId: string) => RelayApiHandle
  /** TEST SEAM: approval-timeout backstop (default `APPROVAL_TIMEOUT_MS`). */
  timeoutMs?: number
}

export interface RelayTab {
  sessionId: string
  projectId: string
  /** Tear the tab's session down (runs the held presence teardown + relay socket close, once). */
  dispose(): void
}

/**
 * Bootstrap a relay project tab. Resolves once the connection is mutually approved and the tab is
 * live; REJECTS (never hangs) if the socket drops or times out before approval.
 */
export async function openRelayTab(
  connectionId: string,
  label: string,
  deps: RelayTabDeps
): Promise<RelayTab> {
  const build = deps.buildApi ?? buildRelayApi
  // Built BEFORE we await ready() so the one-shot onApproved listener is registered in time.
  const handle = build(connectionId)

  try {
    await raceApproval(handle, connectionId, deps)
  } catch (err) {
    handle.close() // tear the dead/stuck relay socket down before surfacing the failure
    throw err
  }

  const session = createSession('relay', handle.api, label)
  // The teardowns the tab owes on disconnect (obligation 1): the presence subscription this session
  // just opened, and the relay socket. Both run exactly once in disposeSession.
  holdSessionTeardown(session.id, getSessionStores(session.id).presence.connect())
  holdSessionTeardown(session.id, () => handle.close())

  const project = deps.addProject(label)
  bindProjectToSession(project.id, session.id)
  setActiveSession(session.id)
  deps.setActiveProject(project.id)

  return {
    sessionId: session.id,
    projectId: project.id,
    dispose: () => disposeSession(session.id),
  }
}

/** Resolve on approval (`handle.ready()`); reject on a pre-approval socket drop or a timeout. */
function raceApproval(
  handle: RelayApiHandle,
  connectionId: string,
  deps: RelayTabDeps
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let unClose: () => void = () => {}
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      unClose()
      if (timer) clearTimeout(timer)
      fn()
    }
    unClose = deps.relayClient.onClosed(connectionId, () =>
      finish(() => reject(new Error('The relay connection closed before it was approved.')))
    )
    timer = setTimeout(
      () => finish(() => reject(new Error('Timed out waiting for the host to approve.'))),
      deps.timeoutMs ?? APPROVAL_TIMEOUT_MS
    )
    handle.ready().then(
      () => finish(resolve),
      (err) => finish(() => reject(err instanceof Error ? err : new Error(String(err))))
    )
  })
}
