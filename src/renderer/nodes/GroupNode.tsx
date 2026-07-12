import { useEffect, useState } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { NODE_COLORS, ungroupNodes, type CanvasNode } from '../state/workspace'
import { useProjects } from '../state/projects'
import { useWorktrees, WORKTREE_STATUS_THROTTLE_MS } from '../state/worktrees'

export type WorktreeAction = 'merge' | 'remove' | 'unbind'

/**
 * Worktree-action handler bridge. React Flow instantiates custom nodes itself, so we can't
 * pass Canvas callbacks through props; Canvas registers its handler here (the same indirection
 * the file already relies on — GroupNode reaches React Flow state via `useReactFlow`). Set by
 * Canvas on mount; called by the header chip's action buttons.
 */
let worktreeActionHandler: ((groupId: string, action: WorktreeAction) => void) | null = null
export function setWorktreeActionHandler(
  fn: ((groupId: string, action: WorktreeAction) => void) | null
): void {
  worktreeActionHandler = fn
}

/**
 * A group frame: a dashed, rounded, translucent box that contains child nodes. A floating
 * label pill (color dot + name) sits on the top border; ungroup/× appear top-right on hover.
 * Children are real React Flow nodes parented to this one, so dragging the frame moves them
 * together. The frame renders behind its children (it appears first in the array).
 */
export function GroupNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, setNodes } = useReactFlow()
  const [showColors, setShowColors] = useState(false)

  const wt = data.worktree
  // The store is the ONLY caller of the worktree/status git IPC; it throttles
  // (WORKTREE_STATUS_THROTTLE_MS) and is epoch-guarded, so asking often is free.
  const status = useWorktrees((s) => (wt ? s.statusByPath[wt.path] : undefined))
  const stale = useWorktrees((s) => (wt ? s.staleGroupIds.includes(id) : false))

  // On an SSH project the poll is OFF, not merely useless: `git status <path>` would be answered by
  // the LOCAL filesystem for a project whose checkout lives on the host (remote git routing is
  // exact-cwd, and a worktree path is never the project's remoteCwd), so the chip would report a
  // local directory's branch — or, far worse, strike the group out and unlock the stale-Unbind path,
  // which rewrites the children's cwds. Worktrees are unsupported in SSH projects (v1): the honest
  // behaviour is no facts at all, not local facts about a remote checkout.
  const sshProject = useProjects((s) => !!s.projects.find((p) => p.id === s.activeProjectId)?.ssh)
  const wtPath = sshProject ? undefined : wt?.path
  // Asking once per render is NOT enough to make the chip live: nothing re-renders a group frame
  // while the user works inside its terminals, so the dirty count would freeze at whatever it was
  // when the node last happened to render (verified — it sat at "0 changed" until the canvas was
  // clicked). Hence a tick. It owns no cache and no `git status` of its own: it just pokes the
  // store, whose throttle still decides whether a real read happens (so N frames don't mean N
  // reads, and a mid-window render still coalesces).
  //
  // A STALE worktree is polled too (that is how a group un-stales when the directory comes back —
  // e.g. the user restored it, or a git read failed transiently), and the poke carries the group id
  // so the store can flip staleness live instead of only at project load.
  //
  // `git status` is the full Source-Control read (~10 git subprocesses), so it is gated on page
  // visibility: a hidden tab / minimized window polls nothing, and a `visibilitychange` back to
  // visible pokes immediately so the chip is correct the moment it is seen again. (Gating here
  // rather than hoisting a single store-owned timer keeps the poll tied to the node's own
  // mount/unmount lifecycle — no registry to leak — and the store's throttle already coalesces
  // several groups on the same path.)
  useEffect(() => {
    if (!wtPath) return
    const poke = (): void => {
      if (document.visibilityState === 'hidden') return
      void useWorktrees.getState().refreshStatus(wtPath, id)
    }
    poke()
    const t = setInterval(poke, WORKTREE_STATUS_THROTTLE_MS)
    document.addEventListener('visibilitychange', poke)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', poke)
    }
  }, [wtPath, id])

  // Dissolving the frame destroys the worktree binding (the frame IS the binding) while the
  // worktree itself stays on disk. Route that through Canvas's `unbind` first, so the store
  // re-reconciles (the worktree is offered as an orphan again, and a stale registration is
  // pruned) instead of the binding silently vanishing until the next project switch.
  const ungroup = (): void => {
    if (wt) worktreeActionHandler?.(id, 'unbind')
    setNodes((ns) => ungroupNodes(ns as CanvasNode[], id))
  }

  // A bound frame must read as a checkout at a glance: solid border + a stronger tint of the
  // group's OWN color (no new palette). Stale drops the hue entirely and goes muted/warning.
  const bound = !!wt
  const frameClass = [
    'group-node',
    selected ? 'selected' : '',
    bound ? 'group-node--worktree' : '',
    bound && stale ? 'group-node--worktree-stale' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={frameClass}
      style={{
        borderColor: bound && stale ? undefined : data.color,
        background: bound && stale ? undefined : `${data.color}${bound ? '1c' : '0f'}`,
        // Rounded selection ring (box-shadow follows border-radius, unlike the resizer line).
        boxShadow: selected ? `0 0 0 1.5px ${data.color}` : undefined
      }}
    >
      <NodeResizer
        minWidth={200}
        minHeight={140}
        isVisible={selected}
        color={data.color}
        lineStyle={{ borderColor: 'transparent' }}
      />

      <div className="group-node__label">
        <button
          className="group-node__dot nodrag"
          style={{ background: data.color }}
          title="Color"
          onClick={() => setShowColors((v) => !v)}
        />
        {showColors && (
          <div className="color-popover">
            {NODE_COLORS.map((c) => (
              <button
                key={c}
                style={{ background: c }}
                onClick={() => {
                  updateNodeData(id, { color: c })
                  setShowColors(false)
                }}
              />
            ))}
          </div>
        )}
        <input
          className="group-node__name nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        {wt && (
          <div className="group-node__wt nodrag">
            {stale ? (
              // The directory is gone from disk (deleted outside the app). Merge and Remove would
              // act on a path that no longer exists, so only Unbind is offered.
              <span
                className="group-node__branch group-node__branch--stale"
                title={`Worktree directory is gone: ${wt.path}\nUnbind to detach this group from it.`}
              >
                ⎇ {wt.branch} · missing
              </span>
            ) : (
              <span className="group-node__branch" title={wt.path}>
                {/* The branch git reports NOW wins: the user may have switched branches inside
                    the worktree from a terminal, and the persisted name would then be a lie. */}
                ⎇ {status?.branch || wt.branch}
                {!!status && status.dirty > 0 && (
                  <em className="group-node__wt-dirty" title={`${status.dirty} changed file(s)`}>
                    {' '}
                    · {status.dirty} changed
                  </em>
                )}
                {!!status && status.ahead > 0 && (
                  <em className="group-node__wt-ahead" title={`${status.ahead} commit(s) ahead`}>
                    {' '}
                    · {status.ahead}↑
                  </em>
                )}
                {!!status && status.behind > 0 && (
                  <em className="group-node__wt-behind" title={`${status.behind} commit(s) behind`}>
                    {' '}
                    · {status.behind}↓
                  </em>
                )}
              </span>
            )}
            {!stale && (
              <button
                className="group-node__wt-btn"
                title="Merge to main"
                onClick={() => worktreeActionHandler?.(id, 'merge')}
              >
                ⤴
              </button>
            )}
            <button
              className="group-node__wt-btn"
              title={
                stale
                  ? 'Unbind (the directory is gone — also prunes the stale git registration)'
                  : 'Unbind worktree (keeps the worktree on disk)'
              }
              onClick={() => worktreeActionHandler?.(id, 'unbind')}
            >
              Unbind
            </button>
            {!stale && (
              <button
                className="group-node__wt-btn"
                title="Remove worktree"
                onClick={() => worktreeActionHandler?.(id, 'remove')}
              >
                ✕
              </button>
            )}
          </div>
        )}
      </div>

      <div className="group-node__actions nodrag">
        <button className="group-node__ungroup" title="Ungroup" onClick={ungroup}>
          ungroup
        </button>
        <button
          className="group-node__close"
          title="Remove group (keeps nodes)"
          onClick={ungroup}
        >
          ×
        </button>
      </div>
    </div>
  )
}
