// IPC channel names — single source of truth for both main and preload.

export const IPC = {
  ptyCreate: 'pty:create',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyFlow: 'pty:flow',
  ptyKill: 'pty:kill',
  ptyDestroy: 'pty:destroy',
  /** End a node's persistent session so the SAME node id can respawn in a new cwd ("move into
   *  worktree"). Same tmux kill-session as `ptyDestroy`, but it is NOT a deletion: the node stays
   *  on every canvas, so co-viewers get the restart notice (`ptyRecycled`) instead of the
   *  permanent, un-respawnable `ptyClosed`. */
  ptyRecycle: 'pty:recycle',
  ptyGenerateName: 'pty:generate-name',
  ptyGenerateGroupName: 'pty:generate-group-name',
  ptyCapture: 'pty:capture',
  ptyReadScrollback: 'pty:read-scrollback',
  ptySendText: 'pty:send-text',
  ptyReadSessionName: 'pty:read-session-name',
  claudeReadTranscript: 'claude:read-transcript',
  chatReadTranscript: 'chat:read-transcript',
  chatEnsure: 'chat:ensure',
  chatSend: 'chat:send',
  chatInterrupt: 'chat:interrupt',
  chatPermissionReply: 'chat:permission-reply',
  chatRemoveQueued: 'chat:remove-queued',
  chatDispose: 'chat:dispose',
  chatEvent: (nodeId: string) => `chat:event:${nodeId}`,
  claudeAccountsAdd: 'claude-accounts:add',
  claudeAccountsWaitLogin: 'claude-accounts:wait-login',
  claudeAccountsCancelWait: 'claude-accounts:cancel-wait',
  claudeAccountsRemove: 'claude-accounts:remove',
  claudeCliCaps: 'claude-cli:caps',
  transcriptSearch: 'transcript:search',
  appToggleMarkdown: 'app:toggle-markdown',
  appCloseNode: 'app:close-node',
  appCloseWindow: 'app:close-window',
  appNotify: 'app:notify',
  appOpenNotificationSettings: 'app:open-notification-settings',
  appFocusNode: 'app:focus-node',
  appSetBadge: 'app:set-badge',
  agentStatus: 'agent:status',
  agentSubagentActivity: 'agent:subagent-activity',
  agentControl: 'agent:control',
  agentControlResult: 'agent:control-result',
  /** Canvas sync: a client casts its local node mutations here; the core reflector
   *  (src/core/canvas-sync.ts) stamps each with the total order (`seq`) and sends it back out on the
   *  SAME channel to EVERY attached client — the sender included, whose copy is its ack (see
   *  src/shared/canvas-order.ts). Args (both directions): [projectId: string, CanvasMutation]. */
  canvasMut: 'canvas:mut',
  contextLinkSetLinks: 'context-link:set-links',
  contextLinkInfo: 'context-link:info',
  appUpdateAvailable: 'app:update-available',
  appUpdateDownloaded: 'app:update-downloaded',
  appUpdateProgress: 'app:update-progress',
  appUpdateError: 'app:update-error',
  appUpdateNotAvailable: 'app:update-not-available',
  appCheckForUpdates: 'app:check-for-updates',
  appGetVersion: 'app:get-version',
  appUserDataDir: 'app:user-data-dir',
  appUpdatePolicy: 'app:update-policy',
  licenseActivate: 'license:activate',
  licenseDeactivate: 'license:deactivate',
  licenseStatus: 'license:status',
  licenseChanged: 'license:changed',
  licenseUpgrade: 'license:upgrade',
  appRestartToUpdate: 'app:restart-to-update',
  announcementsFetch: 'announcements:fetch',
  usageFetch: 'usage:fetch',
  usageRefresh: 'usage:refresh',
  usageUpdate: 'usage:update',
  contextUpdate: 'context:update',
  contextEnsure: 'context:ensure',
  // Team presence (docs/team-presence.md). `presence:hello` is a REQUEST: its response tells the
  // client its own clientId, so it never draws its own cursor. The rest are casts (client→server)
  // and events (server→clients); the server is a dumb reflector and applies no policy.
  presenceHello: 'presence:hello',
  presenceCursor: 'presence:cursor',
  presenceFocus: 'presence:focus',
  presenceChat: 'presence:chat',
  // Which project (canvas) the client is looking at. Cursors/focus are only meaningful to a
  // viewer on the same project — each project has its own nodes and coordinate space.
  presenceProject: 'presence:project',
  presenceSync: 'presence:sync',
  presencePeer: 'presence:peer',
  // Events broadcast from main to the renderer (sessionId is appended to the channel name).
  ptyData: (sessionId: string) => `pty:data:${sessionId}`,
  ptyExit: (sessionId: string) => `pty:exit:${sessionId}`,
  /** Authoritative size of a co-attached session: min(cols) × min(rows) over all subscribers.
   *  Broadcast to every subscriber whenever the subscriber set or any reported size changes. */
  ptySize: (sessionId: string) => `pty:size:${sessionId}`,
  /** The node was permanently destroyed by another client (payload: { by: ClientId }). The
   *  remaining subscribers show a "closed by <name>" state instead of respawning the session. */
  ptyClosed: (sessionId: string) => `pty:closed:${sessionId}`,
  /** The node's session was RECYCLED by another client (moved into a worktree): this session id is
   *  dead, but a replacement is already live under the same node id — restart the terminal so it
   *  co-attaches to it. Deliberately emitted only AFTER the replacement session exists (see
   *  PtyManager.recycleSession), so a co-viewer's restart can never spawn the node in its own,
   *  stale cwd.
   *  Payload: `{ ready: boolean }`. `ready:true` = the replacement session is registered, restart
   *  onto it. `ready:false` = the escape-hatch timeout fired and NO replacement ever came (the
   *  recycler's app died mid-move): the terminal must NOT respawn — it would spawn `nt-<id>` in
   *  its own stale cwd and silently undo the move — it ends and offers a manual reopen. */
  ptyRecycled: (sessionId: string) => `pty:recycled:${sessionId}`,
  /** Redraw for a client that fell too far behind: the session's CURRENT screen, captured from
   *  tmux. Sent instead of the discarded backlog (payload: the capture text). The terminal clears
   *  and repaints from it — see ServerPlatform's WS_DROP_WATER.
   *  CONTRACT: the payload is guaranteed NON-EMPTY (a failed capture is retried, never sent — an
   *  empty redraw would wipe a live terminal). The renderer must still IGNORE an empty payload
   *  rather than reset on it. */
  ptyResync: (sessionId: string) => `pty:resync:${sessionId}`,
  workspaceLoad: 'workspace:load',
  workspaceSave: 'workspace:save',
  workspaceProbeFolder: 'workspace:probe-folder',
  // main → renderer events
  workspaceMigrated: 'workspace:migrated',
  workspaceExternalChange: 'workspace:external-change',
  dialogSelectFolder: 'dialog:select-folder',
  dialogSelectFile: 'dialog:select-file',
  shellReveal: 'shell:reveal',
  shellOpenPath: 'shell:open-path',
  fsList: 'fs:list',
  fsRead: 'fs:read',
  fsReadBinary: 'fs:read-binary',
  fsWrite: 'fs:write',
  fsMkdir: 'fs:mkdir',
  fsExists: 'fs:exists',
  filesQuickOpen: 'files:quick-open',
  settingsLoad: 'settings:load',
  settingsSave: 'settings:save',
  sshList: 'ssh:list',
  sshSave: 'ssh:save',
  sshDelete: 'ssh:delete',
  sshImport: 'ssh:import-candidates',
  sshConnectProject: 'ssh:connect-project',
  sshDisconnectProject: 'ssh:disconnect-project',
  sshKillSessions: 'ssh:kill-sessions',
  sshListDir: 'ssh:list-dir',
  sshMkdir: 'ssh:mkdir',
  sshUploadFile: 'ssh:upload-file',
  sshFsList: 'sshFs:list',
  sshFsRead: 'sshFs:read',
  sshFsReadBinary: 'sshFs:read-binary',
  sshFsWrite: 'sshFs:write',
  sshFsMkdir: 'sshFs:mkdir',
  sshFsExists: 'sshFs:exists',
  sshProjectStatus: 'ssh-project:status',
  gitStatus: 'git:status',
  gitInit: 'git:init',
  gitClone: 'git:clone',
  gitCloneAbort: 'git:clone-abort',
  gitCloneDefaultParent: 'git:clone-default-parent',
  /** main → renderer event: { phase, percent } while a clone runs. */
  gitCloneProgress: 'git:clone-progress',
  gitCommit: 'git:commit',
  gitPush: 'git:push',
  gitPull: 'git:pull',
  gitSync: 'git:sync',
  gitPublish: 'git:publish',
  gitStage: 'git:stage',
  gitUnstage: 'git:unstage',
  gitStageAll: 'git:stage-all',
  gitUnstageAll: 'git:unstage-all',
  gitDiff: 'git:diff',
  gitDiscard: 'git:discard',
  gitSwitchBranch: 'git:switch-branch',
  gitCreateBranch: 'git:create-branch',
  gitShowFile: 'git:show-file',
  gitHistory: 'git:history',
  gitCommitFiles: 'git:commit-files',
  gitRemoteCommitUrl: 'git:remote-commit-url',
  gitMerge: 'git:merge',
  gitRebase: 'git:rebase',
  gitDeleteBranch: 'git:delete-branch',
  gitRenameBranch: 'git:rename-branch',
  gitFetch: 'git:fetch',
  gitForcePush: 'git:force-push',
  gitStashPush: 'git:stash-push',
  gitStashPop: 'git:stash-pop',
  gitRevert: 'git:revert',
  gitBranchAt: 'git:branch-at',
  gitCheckoutCommit: 'git:checkout-commit',
  gitRepoRoot: 'git:repo-root',
  gitWorktreeList: 'git:worktree-list',
  gitWorktreeAdd: 'git:worktree-add',
  gitWorktreeMerge: 'git:worktree-merge',
  gitWorktreeRemove: 'git:worktree-remove',
  gitSetActiveRemote: 'git:set-active-remote',
  shellOpenExternal: 'shell:open-external',
  commitGenerate: 'commit:generate',
  mediaAllow: 'media:allow',
  mediaWriteHtml: 'media:write-html',
  browserRegister: 'browser:register',
  browserUnregister: 'browser:unregister',
  browserNewWindow: 'browser:new-window',
  remoteHostStart: 'remote:host:start',
  remoteHostStop: 'remote:host:stop',
  // Connection approval gate: main → renderer when a client finishes the handshake (carries the
  // SAS to display); renderer → main to approve/reject. Until approved, the host serves no
  // pty/fs RPCs or input frames, so a leaked offer cannot grant silent access.
  remoteHostPeerPending: 'remote:host:peer-pending',
  remoteHostApprove: 'remote:host:approve',
  remoteHostReject: 'remote:host:reject',
  // Host canvas mirror: renderer pushes its serialized active-project canvas to main;
  // main pushes a client's mutation back to the host renderer to apply.
  remoteHostCanvasState: 'remote:host:canvas-state',
  remoteHostApplyMutation: 'remote:host:apply-mutation',
  // Standing (phone) relay host: renderer toggles it on/off (settings.phoneAccessEnabled). Main
  // starts/stops the always-on host connection so a paired phone can reach this Mac over the relay.
  remoteStandingHostSet: 'remote:standing-host:set',
  // Remote-access CLIENT (drives a host's PTYs over the relay).
  remoteClientConnect: 'remote:client:connect',
  remoteClientDisconnect: 'remote:client:disconnect',
  remoteClientCreate: 'remote:client:create',
  remoteClientWrite: 'remote:client:write',
  remoteClientResize: 'remote:client:resize',
  remoteClientKill: 'remote:client:kill',
  // Client canvas mirror: main pushes the host's full canvas snapshot to the client renderer;
  // the client renderer sends its local mutations back for main to RPC to the host.
  remoteClientMutate: 'remote:client:mutate',
  // Remote filesystem: the client proxies the local `fs:*` shape onto the host over the relay.
  remoteClientFsList: 'remote:client:fs-list',
  remoteClientFsRead: 'remote:client:fs-read',
  remoteClientFsReadBinary: 'remote:client:fs-read-binary',
  remoteClientFsWrite: 'remote:client:fs-write',
  // The channel SAS pushed main->renderer once the client handshake completes, so the client
  // human can compare it with the code shown on the host before the host approves.
  remoteClientSas: (connectionId: string) => `remote:client:sas:${connectionId}`,
  // Host canvas snapshot pushed main->renderer for a connection (connectionId appended).
  remoteClientCanvasState: (connectionId: string) => `remote:client:canvas-state:${connectionId}`,
  // Per-session events broadcast main->renderer (connectionId + streamId appended).
  remoteClientData: (connectionId: string, streamId: number) =>
    `remote:client:data:${connectionId}:${streamId}`,
  remoteClientExit: (connectionId: string, streamId: number) =>
    `remote:client:exit:${connectionId}:${streamId}`,
  // Fired when a connection's relay socket drops (host/relay gone).
  remoteClientClosed: (connectionId: string) => `remote:client:closed:${connectionId}`,
  handoffBuild: 'handoff:build',
  // Phone pairing (nodeterm iOS "scan a QR" flow): renderer starts/stops the one-shot LAN
  // listener; main pushes the completion result back over `pairing:done`. The per-device
  // registry (list/revoke) lives in ~/.nodeterm/agent.json.
  pairingStart: 'pairing:start',
  pairingStop: 'pairing:stop',
  pairingDone: 'pairing:done',
  pairingListDevices: 'pairing:listDevices',
  pairingRevokeDevice: 'pairing:revokeDevice'
} as const
