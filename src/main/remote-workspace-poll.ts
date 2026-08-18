/** What the connected-SSH-project workspace poll should do this tick.
 *
 *  The poll is how a session the phone registered into an SSH project's
 *  `<remoteCwd>/.nodeterm/project.json` reaches the desktop canvas — the file lives on the host, so
 *  nothing local can watch it. Reading it needs that project's ControlMaster, and `connect()` is
 *  only ever called from the renderer's ACTIVE-project effect. A project sitting in a background
 *  tab (or never opened since launch) therefore had NO ref, was skipped every tick, and the phone's
 *  node only appeared when the user happened to click that tab.
 *
 *  Dialing every SSH project to close that gap is not acceptable: a connect is a real TCP + auth,
 *  it can raise a passphrase prompt, and it would fire for every host in the workspace at launch,
 *  including ones that are simply down. So the sweep is REUSE-ONLY: a project with no live ref is
 *  offered for adoption only when its ControlMaster socket already exists on disk — a master that
 *  outlived the last app run under ControlPersist, or one this run opened and dropped from its map.
 *  `connect()` takes its orphan-adopt branch there (an `-O check`, no new auth, no prompt); if the
 *  socket is dead the caller's own `-O check` says so and we leave it alone. Nothing here ever
 *  causes a project with no socket to be dialed.
 */
export interface RemoteWorkspacePollPlan {
  /** Projects to read this tick (a live master is already in hand). */
  poll: string[]
  /** Projects to try to ADOPT an already-running master for, so they join `poll` next tick. */
  adopt: string[]
}

export interface RemoteWorkspacePollInput {
  /** Every ssh entry in the workspace index, active tab or not. */
  sshProjectIds: string[]
  /** Does this project have a ControlMaster this app run is holding? */
  hasLiveRef: (projectId: string) => boolean
  /** Is a read — or an adoption attempt — already running for it? Keeps a hung ssh from stacking. */
  busy: (projectId: string) => boolean
  /** Does the project's ControlPath socket exist on disk? The gate that makes adoption reuse-only. */
  hasControlSocket: (projectId: string) => boolean
}

export function planRemoteWorkspacePoll(input: RemoteWorkspacePollInput): RemoteWorkspacePollPlan {
  const plan: RemoteWorkspacePollPlan = { poll: [], adopt: [] }
  for (const projectId of input.sshProjectIds) {
    if (input.busy(projectId)) continue
    if (input.hasLiveRef(projectId)) plan.poll.push(projectId)
    else if (input.hasControlSocket(projectId)) plan.adopt.push(projectId)
    // No ref and no socket: nothing to reuse. Never dialed — see the header.
  }
  return plan
}
