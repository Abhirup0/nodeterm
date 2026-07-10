import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
  applyEdgeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  SelectionMode,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type Viewport
} from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'
import {
  TerminalNode,
  setMoveIntoWorktreeHandler,
  disposeTerminalOnUnmount
} from '../nodes/TerminalNode'
import { StickyNode } from '../nodes/StickyNode'
import { GroupNode, setWorktreeActionHandler } from '../nodes/GroupNode'
import { LazyEditorNode, LazyDiffNode } from '../nodes/lazyMonacoNodes'
import { DinoNode } from '../nodes/DinoNode'
import BrowserNode from '../nodes/BrowserNode'
import ChatNode from '../nodes/ChatNode'
import { normalizeAddress } from '../nodes/browserUrl'
import VideoNode from '../nodes/VideoNode'
import WebNode from '../nodes/WebNode'
import { withNodeBoundary } from '../components/NodeBoundary'
import { Dock } from '../components/Dock'
import { TabBar } from '../components/TabBar'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { CommandPalette, type Command } from '../components/CommandPalette'
import {
  IconCollapse,
  IconBranch,
  IconDuplicate,
  IconEditor,
  IconFit,
  IconGrid,
  IconGroup,
  IconChat,
  IconDino,
  IconJump,
  IconMarkdown,
  IconNote,
  IconProject,
  IconRemote,
  IconSave,
  IconSelectAll,
  IconSessions,
  IconSwitch,
  IconTerminal,
  IconTrash,
  IconUngroup
} from '../components/icons'
import { SettingsPage } from '../components/settings/SettingsPage'
import type { SettingsSectionId } from '../components/settings/nav'
import { SourceControlPanel } from '../components/SourceControlPanel'
import { WelcomeScreen } from '../components/WelcomeScreen'
import { CloneRepoDialog } from '../components/CloneRepoDialog'
import { ShortcutsPanel } from '../components/ShortcutsPanel'
import { UpdateCard } from '../components/UpdateCard'
import { AnnouncementBanner } from '../components/AnnouncementBanner'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { promptDialog } from '../components/promptDialog'
import { UpgradeDialog } from '../components/UpgradeDialog'
import { RemotePicker } from '../components/RemotePicker'
import { BindWorktreeDialog, type BindWorktreeValue } from '../components/BindWorktreeDialog'
import { NotifyConsentDialog } from '../components/NotifyConsentDialog'
import { ExplorerPanel } from '../components/ExplorerPanel'
import { SessionsSidebar } from '../components/SessionsSidebar'
import type { SessionNodeInput } from '../lib/sessionList'
import { UsageIndicator } from '../components/UsageIndicator'
import { RemoteSessionView } from './RemoteSessionView'
import { RemoteAccessDialog } from '../components/RemoteAccessDialog'
import { SshProjectDialog } from '../components/SshProjectDialog'
import { transport } from '../terminal/local-transport'
import { prepareQuickOpenFiles, type QuickOpenIndexedFile } from '../lib/quickOpenSearch'
import { opensInEditor } from '../lib/openTarget'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import { useChatSessions } from '../state/chatSessions'
import { useAgentNodes } from '../state/agentNodes'
import { SubagentNode } from '../nodes/SubagentNode'
import { LoopNode } from '../nodes/LoopNode'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import { computeWorktreePath, sanitizeWorktreeBranch } from '@shared/worktree'
import {
  agentConfig,
  hasHooks,
  canBranch,
  canRename,
  canTransferFrom,
  canContextLink,
  canControlCanvas,
  resumeCommand,
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  type AgentId
} from '@shared/agents/config'
import { relativeTime } from '../lib/relativeTime'
import { AgentIcon } from '../lib/agentIcons'
import { branchClaudeSession } from '../lib/claudeBranch'
import { buildContextLinkNote, buildLinkMap, buildNotePushMessage, classifyLink, type LinkEndpoint } from '../lib/noteLink'
import { useSettings } from '../state/settings'
import { useRemoteHosting } from '../state/remoteHosting'
import { useContextWindow } from '../state/contextWindow'
import { useSessionNaming } from '../state/sessionNaming'
import { useSshServers } from '../state/sshServers'
import { useSshConn } from '../state/sshConn'
import { useSystemAccount } from '../state/systemAccount'
import { requireProOr } from '../state/upgradeGate'
import { useEntitlement } from '../state/entitlement'
import type { SshServer } from '@shared/ssh'
import { sshHostKey } from '@shared/ssh'
import type { SshProjectStatus, TranscriptHit } from '@shared/types'
import {
  applyCanvasMutation,
  claudeLaunchCommand,
  COLLAPSED_HEIGHT,
  alignNodes,
  arrangeNodes,
  createAccountLoginNode,
  isAccountLoginNode,
  systemAccountDisplay,
  createAgentNode,
  createBrowserNode,
  createChatNode,
  createDinoNode,
  createDiffNode,
  createEditorNode,
  createSshTerminalNode,
  createStickyNode,
  createTerminalNode,
  createVideoNode,
  createWebNode,
  isVideoFile,
  duplicateNode,
  flowToNodeStates,
  groupSelectedNodes,
  nodeStatesToFlow,
  reorderNodeBefore,
  reparentNode,
  resolveNewNodeAccount,
  accountsForProject,
  ungroupNodes,
  type CanvasNode
} from '../state/workspace'

const GRID = 24

// Group labels counter-scale when zoomed OUT so they stay readable/clickable from afar
// (like map labels): full inverse of the zoom, capped so far-out labels don't get huge,
// and never below 1 (zooming IN doesn't shrink them). Written as a CSS var once per
// viewport frame (see onMove) — CSS does the scaling, no per-node re-render.
const setGroupLabelBoost = (zoom: number): void => {
  // Cap 4 = constant on-screen size down to 25% zoom; beyond that it shrinks again so
  // pills can't blanket the canvas at extreme zoom-out (minZoom goes to 0.01).
  const boost = Math.min(4, Math.max(1, 1 / (zoom || 1)))
  document.documentElement.style.setProperty('--group-label-boost', boost.toFixed(3))
}

// Stable identity for the common case of no subagent/loop fan-out, so the ephemeral
// memo doesn't allocate fresh arrays on every node change (e.g. each drag frame).
const NO_EPHEMERAL: { ephemeralNodes: CanvasNode[]; ephemeralEdges: Edge[] } = {
  ephemeralNodes: [],
  ephemeralEdges: []
}

// A "spawned by" rope: control-capable agent → node it opened (or browser popup → opener).
// Display-only (never a context link) but persisted per project as `ropes`, so the lineage
// survives restarts. Selectable; removed with ⌫ / double-click like a context link.
const ropeEdge = (id: string, source: string, target: string, color: string): Edge => ({
  id,
  source,
  sourceHandle: 'flow-out',
  target,
  targetHandle: 'flow-in',
  style: { stroke: color, strokeWidth: 1.5 },
  markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 }
})

const minimapNodeColor = (n: Node): string =>
  (n.data as { color?: string })?.color ?? '#0a84ff'

// The minimap subscribes to agent status HERE, in its own tiny component — not in Canvas.
// Canvas must not subscribe to the whole status map (every working/waiting flip would re-render
// the entire canvas), but the minimap's working/attention/unread strokes DO need to track those
// flips live; a fresh `nodeStrokeColor` identity per status change is what busts React Flow's
// internal MiniMap memo so it repaints. Re-render cost is confined to this component.
function StatusAwareMiniMap({ onNodeDoubleClick }: { onNodeDoubleClick: (node: Node) => void }) {
  const statusById = useAgentStatus((s) => s.byId)
  const { setCenter, getZoom } = useReactFlow()
  // React Flow's MiniMap only pans on drag (`pannable`) — a plain click is a no-op unless
  // wired up. `position` arrives already converted to flow coordinates.
  const onMinimapClick = useCallback(
    (_e: React.MouseEvent, position: { x: number; y: number }) => {
      setCenter(position.x, position.y, { zoom: getZoom(), duration: 300 })
    },
    [setCenter, getZoom]
  )
  // The MiniMap has no double-click prop; `detail === 2` is the second click of a
  // double-click. stopPropagation keeps the svg-level click handler above from
  // re-centering at the raw pointer right after the zoom-to-node.
  const onMinimapNodeClick = useCallback(
    (e: React.MouseEvent, node: Node) => {
      if (e.detail >= 2) {
        e.stopPropagation()
        onNodeDoubleClick(node)
      }
    },
    [onNodeDoubleClick]
  )
  // Status language matches the canvas glows/badges: amber = working, red = needs you,
  // accent blue = unread. The classes below add the minimap-scale glow/pulse (styles.css).
  const nodeStrokeColor = useCallback(
    (n: Node): string => {
      const st = statusById[n.id]
      if (st?.state === 'working') return '#ffd60a'
      if (st?.state === 'waiting' || st?.state === 'blocked') return '#ff453a'
      if (st?.unread) return '#0a84ff'
      return (n.data as { color?: string })?.color ?? '#0a84ff'
    },
    [statusById]
  )
  const nodeClassName = useCallback(
    (n: Node): string => {
      const st = statusById[n.id]
      if (st?.state === 'working') return 'mm-working'
      if (st?.state === 'waiting' || st?.state === 'blocked') return 'mm-attention'
      if (st?.unread) return 'mm-unread'
      return ''
    },
    [statusById]
  )
  return (
    <MiniMap
      className="minimap"
      position="bottom-right"
      pannable
      zoomable
      onClick={onMinimapClick}
      onNodeClick={onMinimapNodeClick}
      maskColor="rgba(10,12,18,0.6)"
      nodeColor={minimapNodeColor}
      nodeStrokeColor={nodeStrokeColor}
      nodeClassName={nodeClassName}
    />
  )
}

export function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  // Persistent context links between Claude nodes (separate from ephemeral subagent/loop edges).
  const [linkEdges, setLinkEdges, onLinkEdgesChange] = useEdgesState<Edge>([])
  const linkEdgesRef = useRef<Edge[]>([])
  linkEdgesRef.current = linkEdges
  // "Spawned by" ropes drawn from a control-capable agent to the nodes it opens via the
  // `nodeterm` CLI (see the onAgentControl effect) and from browser popups to their opener.
  // Merged only at the <ReactFlow> prop and never turned into context links, but PERSISTED
  // per project (`ropes`) so the lineage survives restarts; deletable like a context link.
  const [controlEdges, setControlEdges] = useState<Edge[]>([])
  const controlEdgesRef = useRef<Edge[]>([])
  controlEdgesRef.current = controlEdges
  const [dirty, setDirty] = useState(false)
  const [zoomPct, setZoomPct] = useState(100)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [remotePicker, setRemotePicker] = useState<{ x: number; y: number } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [fileIndex, setFileIndex] = useState<QuickOpenIndexedFile[]>([])
  const [transcriptHits, setTranscriptHits] = useState<TranscriptHit[]>([])
  const transcriptQueryRef = useRef('')
  // Pending debounce timer for the palette transcript search (reset on each keystroke).
  const transcriptSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Cached visible-buffer text per terminal, for command-palette content search.
  const [bufferCache, setBufferCache] = useState<Record<string, string>>({})
  const captureTsRef = useRef<Record<string, number>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  // "+" opens the start screen (WelcomeScreen) on demand over existing projects.
  const [welcomeOpen, setWelcomeOpen] = useState(false)
  // Optional deep-link target when opening settings (e.g. RemotePicker → the SSH section).
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | undefined>(undefined)
  const [scOpen, setScOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [explorerOpen, setExplorerOpen] = useState(false)
  // Reveal-in-Explorer target (relative to the active project cwd). The nonce makes each reveal
  // distinct so revealing the same file twice still re-fires the Explorer effect.
  const [reveal, setReveal] = useState<{ path: string; nonce: number } | null>(null)
  // Sessions sidebar (left): pinned (docked) by default; unpin is a persisted preference.
  // hover-to-peek when unpinned. `dismissed` is a transient "hide for now" (the × button)
  // that does NOT change the pin preference — so a pinned sidebar reopens pinned next launch.
  const [sessionsPinned, setSessionsPinned] = useState(() => {
    try {
      const v = localStorage.getItem('nodeterm.sessionsPinned')
      return v === null ? true : v === '1'
    } catch {
      return true
    }
  })
  const [sessionsHover, setSessionsHover] = useState(false)
  const [sessionsDismissed, setSessionsDismissed] = useState(false)
  // When pinned the sidebar is docked and stays open (mouse-leave never closes it); `dismissed`
  // hides it until the next hover/click. When unpinned it is a pure hover-peek.
  const sessionsOpen = sessionsPinned ? !sessionsDismissed : sessionsHover
  // When set, add a terminal to this project once its nodes have loaded into React Flow
  // (cross-project "add" from the sidebar, which must switch projects first).
  const pendingAddRef = useRef<string | null>(null)
  // When set, a full-surface remote mirror of a connected host is shown over the local canvas.
  const [remoteConnId, setRemoteConnId] = useState<string | null>(null)
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false)
  // "Connect over SSH…" project-creation dialog (from the Welcome screen).
  const [sshDialogOpen, setSshDialogOpen] = useState(false)
  // "Clone repository…" dialog (from the Welcome screen + command palette).
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false)
  // Live SSH ControlMaster status per project id (drives the thin connection banner).
  const [sshStatus, setSshStatus] = useState<Record<string, SshProjectStatus>>({})
  // A client has finished the handshake and is awaiting this host's approval (carries the SAS).
  const [pendingPeer, setPendingPeer] = useState<{ sas: string | null; id: string } | null>(null)
  const [confirm, setConfirm] = useState<{
    message: string
    onConfirm: () => void
    /** Optional: runs when the user cancels/escapes (e.g. to reply 'denied' to an agent). */
    onCancel?: () => void
    confirmLabel?: string
    cancelLabel?: string
    danger?: boolean
  } | null>(null)
  // Node to center once its project finishes loading (cross-project notification click).
  const pendingFocusRef = useRef<string | null>(null)
  const [consentOpen, setConsentOpen] = useState(false)
  // Group id awaiting a worktree bind (drives BindWorktreeDialog).
  const [bindTarget, setBindTarget] = useState<string | null>(null)
  // Writable base dir for the default worktree path (Electron userData), fetched once on mount.
  const userDataDirRef = useRef('')
  useEffect(() => {
    void window.nodeTerminal.userDataDir().then((d) => {
      userDataDirRef.current = d
    })
  }, [])
  // Terminal node id awaiting confirmation to move into its group's worktree.
  const [moveTarget, setMoveTarget] = useState<string | null>(null)
  // Group awaiting confirmation to remove its worktree (drives the ask-first safety dialog).
  const [removeTarget, setRemoveTarget] = useState<{ groupId: string; warning: string } | null>(
    null
  )
  const settings = useSettings((s) => s.settings)
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 })
  const nodesRef = useRef<CanvasNode[]>(nodes)
  // Rolling record of popup-spawned browser nodes (url + source + timestamp) so the deps-[]
  // onBrowserNewWindow effect can dedup repeat opens and rate-cap a flood of window.open calls.
  const browserPopupSpawnsRef = useRef<{ url: string; source: string; t: number }[]>([])
  const loadingRef = useRef(false)
  const flowWrapRef = useRef<HTMLDivElement>(null)
  // Undo/redo history (snapshots of the nodes array; arrays are immutable per change).
  const pastRef = useRef<CanvasNode[][]>([])
  const futureRef = useRef<CanvasNode[][]>([])
  const committedRef = useRef<CanvasNode[]>([])
  const draggingRef = useRef(false)
  const [, bumpHist] = useState(0)
  const { setViewport, getViewport, fitView, zoomIn, zoomOut, screenToFlowPosition, setCenter, getZoom } =
    useReactFlow()

  const activeProjectId = useProjects((s) => s.activeProjectId)
  // "Has projects" = at least one OPEN (non-closed) tab. With only closed projects left, the
  // welcome screen shows (and lists them under "Recently closed" for reopening).
  const hasProjects = useProjects((s) => s.projects.some((p) => !p.closed))
  const closedProjects = useProjects((s) => s.projects.filter((p) => p.closed))
  // The active project's SSH server (if it's an SSH project) — drives the connection banner.
  const activeSshServer = useProjects(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.ssh?.server
  )
  nodesRef.current = nodes
  // Mirror the open-confirm state into a ref so the []-dep agent-control effect can see the
  // CURRENT dialog (it closes over a stale `confirm`), to reject overlapping destructive verbs.
  const confirmRef = useRef(confirm)
  confirmRef.current = confirm

  const nodeTypes = useMemo(
    () => ({
      terminal: withNodeBoundary(TerminalNode),
      sticky: withNodeBoundary(StickyNode),
      group: withNodeBoundary(GroupNode),
      editor: withNodeBoundary(LazyEditorNode),
      diff: withNodeBoundary(LazyDiffNode),
      subagent: withNodeBoundary(SubagentNode),
      loop: withNodeBoundary(LoopNode),
      dino: withNodeBoundary(DinoNode),
      video: withNodeBoundary(VideoNode),
      web: withNodeBoundary(WebNode),
      browser: withNodeBoundary(BrowserNode),
      chat: withNodeBoundary(ChatNode)
    }),
    []
  )

  // Ephemeral subagent nodes + edges (driven by Claude hooks; never persisted / no undo).
  // Laid out fanning below the parent Claude node.
  const agentById = useAgentNodes((s) => s.byId)
  const ephemeralPos = useAgentNodes((s) => s.positions)
  const ephSizes = useAgentNodes((s) => s.sizes)
  const ephExpanded = useAgentNodes((s) => s.expanded)
  // Deliberately NOT `useAgentStatus((s) => s.byId)`: that map's identity changes on every
  // working/waiting flip of any agent node, which re-rendered the whole canvas per hook event.
  // Canvas only needs the /loop entries (for the ephemeral LoopNodes), so subscribe to a
  // primitive signature that changes only when a loop's visible fields do; the memo below
  // reads the actual entries via getState().
  const loopSig = useAgentStatus((s) => {
    let sig = ''
    for (const [id, st] of Object.entries(s.byId)) {
      if (!st.loop) continue
      sig += `${id}|${st.loop.kind ?? ''}|${st.loop.count}|${st.loop.items?.length ?? 0}|${st.loop.task ?? ''}|${st.loop.schedule ?? ''}|${st.state === 'working' ? 1 : 0}|`
    }
    return sig
  })
  // Selection state for ephemeral nodes (they live outside React Flow's managed nodes).
  const [ephSel, setEphSel] = useState<Record<string, boolean>>({})
  const { ephemeralNodes, ephemeralEdges } = useMemo(() => {
    // Common case: no /loop running and no subagents → return a stable empty result so
    // this memo (which depends on `nodes`, i.e. recomputes every drag frame) stays cheap
    // and doesn't churn array identity downstream.
    const claudeById = useAgentStatus.getState().byId // re-read on loopSig change (see above)
    const hasLoops = loopSig !== ''
    const hasAgents = Object.keys(agentById).length > 0
    if (!hasLoops && !hasAgents) return NO_EPHEMERAL
    // Explicit width/height for an ephemeral node (so it resizes like any other node).
    // Defaults switch with expand; a user resize override wins.
    const dims = (id: string, baseW: number, expW: number, baseH: number, expH: number) => {
      const sz = ephSizes[id]
      const exp = !!ephExpanded[id]
      const width = sz?.width ?? (exp ? expW : baseW)
      const height = sz?.height ?? (exp ? expH : baseH)
      return { width, height, style: { width, height } }
    }
    const eNodes: CanvasNode[] = []
    const eEdges: Edge[] = []
    // Loop nodes: one per terminal node currently running a /loop, placed below-left.
    for (const [pid, st] of Object.entries(claudeById)) {
      if (!st.loop) continue
      const parent = nodes.find((n) => n.id === pid)
      if (!parent) continue
      const ph = parent.measured?.height ?? (parent.height as number) ?? 400
      const accent = agentConfig((parent.data.agentId as string) ?? 'claude')?.color ?? '#d97757'
      const lid = `loop-${pid}`
      eNodes.push({
        id: lid,
        type: 'loop',
        // parent.position is group-relative when the agent sits in a group frame; giving the
        // card the same parentId keeps this math in one coordinate space (and the card moves
        // with the group). Deliberately no extent:'parent' — the fan-out may hang below the
        // frame border without being clamped into it.
        ...(parent.parentId ? { parentId: parent.parentId } : {}),
        position: ephemeralPos[lid] ?? { x: parent.position.x - 250, y: parent.position.y + ph + 60 },
        draggable: true,
        selected: !!ephSel[lid],
        ...dims(lid, 230, 460, 92, 320),
        data: {
          title: st.loop.task ?? '',
          color: accent,
          group: null,
          loopCount: st.loop.count,
          loopItems: st.loop.items,
          loopActive: st.state === 'working',
          loopKind: st.loop.kind,
          loopSchedule: st.loop.schedule,
          loopTask: st.loop.task,
          ephExpanded: !!ephExpanded[lid]
        }
      } as CanvasNode)
      eEdges.push({
        id: `e-${lid}`,
        source: pid,
        sourceHandle: 'flow-out',
        target: lid,
        animated: st.state === 'working',
        style: { stroke: accent, strokeWidth: 1.5 }
      })
    }
    const byParent: Record<string, string[]> = {}
    for (const id of Object.keys(agentById)) {
      ;(byParent[agentById[id].parentNodeId] ??= []).push(id)
    }
    for (const [pid, childIds] of Object.entries(byParent)) {
      const parent = nodes.find((n) => n.id === pid)
      if (!parent) continue
      const ph = parent.measured?.height ?? (parent.height as number) ?? 400
      const accent = agentConfig((parent.data.agentId as string) ?? 'claude')?.color ?? '#d97757'
      const COLS = 4
      const COL_W = 240
      const ROW_H = 140
      childIds.forEach((cid, i) => {
        const v = agentById[cid]
        eNodes.push({
          id: cid,
          type: 'subagent',
          // Same coordinate-space rule as the loop card above: inherit the agent's group.
          ...(parent.parentId ? { parentId: parent.parentId } : {}),
          position: ephemeralPos[cid] ?? {
            x: parent.position.x + (i % COLS) * COL_W,
            y: parent.position.y + ph + 60 + Math.floor(i / COLS) * ROW_H
          },
          draggable: true,
          selected: !!ephSel[cid],
          ...dims(cid, 230, 480, 96, 340),
          data: {
            title: v.label ?? '',
            color: accent,
            group: null,
            subagentType: v.type,
            subagentState: v.state,
            subagentStartedAt: v.startedAt,
            subagentDurationMs: v.durationMs,
            subagentTokens: v.tokens,
            subagentToolUses: v.toolUses,
            subagentResult: v.result,
            ephExpanded: !!ephExpanded[cid]
          }
        } as CanvasNode)
        eEdges.push({
          id: `e-${cid}`,
          source: pid,
          sourceHandle: 'flow-out',
          target: cid,
          animated: v.state === 'working',
          style: { stroke: accent, strokeWidth: 1.5 }
        })
      })
    }
    return { ephemeralNodes: eNodes, ephemeralEdges: eEdges }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loopSig stands in for the byId read
  }, [agentById, loopSig, ephemeralPos, ephSizes, ephExpanded, ephSel, nodes])

  // Merge the persisted nodes with the ephemeral ones once per change (not per render),
  // so React Flow's array-identity short-circuit holds while panning/zooming.
  const allNodes = useMemo(
    () => (ephemeralNodes.length ? [...nodes, ...ephemeralNodes] : nodes),
    [nodes, ephemeralNodes]
  )

  // Context-link edges, statically styled (no per-message activity in the pull model).
  const accent = settings.accent
  // Sticky-node id signature: lets displayEdges tell note edges (source is a sticky) apart
  // without depending on the whole nodes array identity (which changes every drag).
  const stickySig = useMemo(
    () =>
      nodes
        .filter((n) => n.type === 'sticky')
        .map((n) => n.id)
        .sort()
        .join('|'),
    [nodes]
  )
  const displayEdges = useMemo(() => {
    const stickyIds = new Set(stickySig ? stickySig.split('|') : [])
    const decorated = linkEdges.map((e) => {
      const sel = !!e.selected
      const isNote = stickyIds.has(e.source)
      const stroke = sel ? '#ffffff' : accent
      const baseLabel = isNote ? '🗒 note' : '⇄ context'
      return {
        ...e,
        type: 'default',
        sourceHandle: 'link-out',
        targetHandle: 'link-in',
        label: sel ? `${baseLabel} — ⌫ to remove` : baseLabel,
        labelStyle: { fill: stroke, fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 5,
        style: { stroke, strokeWidth: sel ? 3.5 : 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
        // Context links are bidirectional (arrowheads both ends); note links flow one way.
        ...(isNote
          ? {}
          : { markerStart: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 } })
      }
    })
    // Control ropes: white + a removal hint while selected (mirrors the context-link look).
    const ropes = controlEdges.map((e) =>
      e.selected
        ? {
            ...e,
            label: '⌫ to remove',
            labelStyle: { fill: '#ffffff', fontSize: 11, fontWeight: 600 },
            labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
            labelBgPadding: [6, 3] as [number, number],
            labelBgBorderRadius: 5,
            style: { ...e.style, stroke: '#ffffff', strokeWidth: 3 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#ffffff', width: 14, height: 14 }
          }
        : e
    )
    const extra = ephemeralEdges.length || ropes.length ? [...ephemeralEdges, ...ropes] : []
    return extra.length ? [...decorated, ...extra] : decorated
  }, [linkEdges, ephemeralEdges, controlEdges, accent, stickySig])

  // Header pin button (and ⌘⇧L): toggle the persisted pin preference. Clears the transient
  // dismiss so (re)pinning shows the docked panel; unpinning collapses it to hover-peek.
  const toggleSessionsPin = useCallback(() => {
    setSessionsPinned((v) => {
      const next = !v
      try {
        localStorage.setItem('nodeterm.sessionsPinned', next ? '1' : '0')
      } catch {
        // ignore
      }
      return next
    })
    // Re-show on (re)pin; on unpin, leave hover as-is so it stays a peek until the cursor leaves.
    setSessionsDismissed(false)
  }, [])

  // Top-left icon click: when pinned, toggle the transient hide/show (keeps the pin); when
  // unpinned, promote the hover-peek to a docked pinned panel.
  const onSessionsIconClick = useCallback(() => {
    if (sessionsPinned) {
      setSessionsDismissed((d) => !d)
    } else {
      setSessionsPinned(true)
      try {
        localStorage.setItem('nodeterm.sessionsPinned', '1')
      } catch {
        // ignore
      }
      setSessionsDismissed(false)
    }
  }, [sessionsPinned])

  // Hover-peek: the sidebar overlaps its trigger icon, so leaving the icon (mouseleave)
  // must not close the peek while the cursor moves onto the sidebar body. A single shared
  // timer lets entering either surface cancel a pending close from the other.
  const sessionsCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const openSessionsPeek = useCallback(() => {
    if (sessionsCloseTimer.current) {
      clearTimeout(sessionsCloseTimer.current)
      sessionsCloseTimer.current = null
    }
    setSessionsHover(true)
    // Hovering re-opens a dismissed sidebar; when pinned this re-docks it so it then stays
    // open after the cursor leaves (open = !dismissed), instead of collapsing like a peek.
    setSessionsDismissed(false)
  }, [])
  const closeSessionsPeekSoon = useCallback(() => {
    if (sessionsCloseTimer.current) clearTimeout(sessionsCloseTimer.current)
    sessionsCloseTimer.current = setTimeout(() => {
      sessionsCloseTimer.current = null
      setSessionsHover(false)
    }, 140)
  }, [])
  useEffect(
    () => () => {
      if (sessionsCloseTimer.current) clearTimeout(sessionsCloseTimer.current)
    },
    []
  )

  // Serialized inputs for the active project's terminal/agent nodes (the sidebar reads the
  // serialized nodes of *inactive* projects directly from the store, but the active project's
  // live state lives in React Flow — pass it through here). Skipped entirely while the sidebar
  // is closed (the common case): this memo recomputes on every `nodes` change, i.e. every drag
  // frame, and the filter+map over all nodes would be pure waste with nobody consuming it.
  const liveActiveNodes = useMemo<SessionNodeInput[] | null>(
    () =>
      sessionsOpen
        ? nodes
            .filter((n) => {
              const k = n.type ?? 'terminal'
              return k === 'terminal' || k === 'group'
            })
            .map((n) => ({
              id: n.id,
              kind: (n.type ?? 'terminal') as SessionNodeInput['kind'],
              title: n.data.title ?? n.id,
              color: n.data.color ?? '#888',
              agentId: n.data.agentId,
              cwd: n.data.cwd,
              ssh: n.data.ssh,
              parentId: n.parentId
            }))
        : null,
    [nodes, sessionsOpen]
  )

  // 1) Load the whole workspace once and hydrate the projects store.
  useEffect(() => {
    let cancelled = false
    // Pull the current license status: the main process broadcasts it on launch, but that
    // broadcast races renderer load and is dropped if it fires first — without this pull a
    // Pro user can start (and stay) gated as free until the next restart.
    void useEntitlement.getState().hydrate()
    useSettings
      .getState()
      .hydrate()
      .then(() => {
        if (!useSettings.getState().settings.seenShortcuts) {
          setShortcutsOpen(true)
          useSettings.getState().update({ seenShortcuts: true })
        }
      })
    window.nodeTerminal.workspace.load().then((ws) => {
      if (cancelled) return
      useProjects.getState().hydrate(ws)
      // Upgrade the on-disk format (e.g. v1 -> v2 migration) right away.
      void window.nodeTerminal.workspace.save(useProjects.getState().toWorkspace())
    })
    return () => {
      cancelled = true
    }
  }, [])

  // 2) Whenever the active project changes, load its canvas into React Flow.
  useEffect(() => {
    if (!activeProjectId) return
    const project = useProjects.getState().getProject(activeProjectId)
    if (!project) return
    // SSH project: (re)open its ControlMaster and record the controlPath so this project's
    // terminal nodes can run over it. Idempotent in main (a live master is reused), so a tab
    // switch back to a connected project is a no-op. Remote tmux is unaffected by the master.
    if (project.ssh) {
      const ssh = project.ssh
      requireProOr('SSH Remote Projects', () => {
        window.nodeTerminal.sshProject
          .connect(project.id, ssh.server, ssh.remoteCwd)
          .then(async ({ controlPath, hookEndpointPath, tmuxConfPath, remoteHome }) => {
            // Arm remote git routing for the active project BEFORE the sshConn entry appears, so the
            // Source Control panel's re-fetch (which keys off that entry) already hits the master.
            await window.nodeTerminal.git.setActiveRemote(project.id)
            useSshConn.getState().setConn(project.id, { controlPath, hookEndpointPath, tmuxConfPath, remoteHome })
          })
          .catch(() => {
            /* status surfaced via onStatus → the connection banner */
          })
      })
    } else {
      // Local active project: ensure all git ops run local (no stale remote from a prior SSH tab).
      void window.nodeTerminal.git.setActiveRemote(null)
    }
    loadingRef.current = true
    const flow = nodeStatesToFlow(project.nodes)
    setNodes(flow)
    setLinkEdges((project.bridges ?? []).map((b) => ({ id: b.id, source: b.source, target: b.target })))
    // Restore control ropes with the source agent's color (falls back to the browser blue).
    setControlEdges(
      (project.ropes ?? []).map((r) => {
        const srcState = project.nodes.find((n) => n.id === r.source)
        const color = agentConfig((srcState?.agentId as AgentId) ?? '')?.color ?? '#0a84ff'
        return ropeEdge(r.id, r.source, r.target, color)
      })
    )
    // Reset history for the newly loaded project.
    committedRef.current = flow
    pastRef.current = []
    futureRef.current = []
    bumpHist((v) => v + 1)
    viewportRef.current = project.viewport
    setViewport(project.viewport)
    setZoomPct(Math.round(project.viewport.zoom * 100))
    setGroupLabelBoost(project.viewport.zoom)
    // Let load-induced changes settle before we start tracking edits as dirty.
    const t = setTimeout(() => {
      loadingRef.current = false
      // The broadcast effect early-returns while `loadingRef` is set and isn't re-triggered by the
      // reset, so push the freshly-loaded project's canvas once now — otherwise a connected client
      // keeps mirroring the previous project until the host's next edit. Gated like the effect:
      // when not hosting, the serialize itself is the waste (main would drop the payload anyway).
      if (useRemoteHosting.getState().hosting) {
        window.nodeTerminal.remoteHost.sendCanvasState({ nodes: flowToNodeStates(nodesRef.current) })
      }
      // Consume a cross-project focus request (notification click on a background node).
      const pending = pendingFocusRef.current
      if (pending) {
        pendingFocusRef.current = null
        const node = nodesRef.current.find((n) => n.id === pending)
        if (node) {
          setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === pending })))
          goToNode(node)
          useAgentStatus.getState().setActive(pending, true)
          useAgentStatus.getState().clearUnread(pending)
        }
      }
      // Consume a cross-project "add terminal" request from the sessions sidebar (which had
      // to switch projects first). Only act if we landed on the requested project.
      if (pendingAddRef.current === useProjects.getState().activeProjectId) {
        pendingAddRef.current = null
        addTerminal()
      }
    }, 0)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, setNodes, setViewport])

  const markDirty = useCallback(() => {
    if (!loadingRef.current) setDirty(true)
  }, [])

  // ---- persistence helpers ----
  const commitActiveToStore = useCallback(() => {
    const id = useProjects.getState().activeProjectId
    if (id)
      useProjects
        .getState()
        .commitCanvas(
          id,
          flowToNodeStates(nodesRef.current),
          viewportRef.current,
          linkEdgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target })),
          controlEdgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target }))
        )
  }, [])

  const writeDisk = useCallback(async () => {
    await window.nodeTerminal.workspace.save(useProjects.getState().toWorkspace())
    setDirty(false)
  }, [])

  const persist = useCallback(async () => {
    commitActiveToStore()
    await writeDisk()
  }, [commitActiveToStore, writeDisk])

  // Debounced auto-save for canvas edits.
  useEffect(() => {
    if (!dirty) return
    const t = setTimeout(() => void persist(), 800)
    return () => clearTimeout(t)
  }, [dirty, persist])

  // ---- remote canvas mirror (host side) ----
  // While hosting, push the serialized active-project canvas to main (debounced ~120ms) on every
  // change, so a connected client mirrors the layout. Gated on the hosting flag: without it every
  // canvas edit paid a full flowToNodeStates serialize + IPC even with no client ever connecting.
  // When hosting flips on, the effect fires once immediately, so main's snapshot is fresh before
  // a client joins. Skips programmatic loads to avoid a redundant push on project switch (the
  // post-load value is captured by the next real change).
  const hosting = useRemoteHosting((s) => s.hosting)
  useEffect(() => {
    if (!hosting || loadingRef.current) return
    const t = setTimeout(() => {
      window.nodeTerminal.remoteHost.sendCanvasState({ nodes: flowToNodeStates(nodesRef.current) })
    }, 120)
    return () => clearTimeout(t)
  }, [nodes, hosting])

  // Apply a client's mutation to React Flow — the host's single writer. Serialize the live nodes,
  // apply the mutation, and convert back. A direct `setNodes(...)` bypasses `handleNodesChange`,
  // so we must mark the project dirty EXPLICITLY — otherwise a client-driven move/delete is lost
  // on host restart/project switch. The `[nodes]` change re-triggers the broadcast effect above,
  // echoing the authoritative state back to the client (intended). The remote edit is also picked
  // up by the undo-snapshot effect, which is acceptable.
  useEffect(() => {
    return window.nodeTerminal.remoteHost.onApplyMutation((mutation) => {
      setNodes((ns) => {
        const next = applyCanvasMutation(flowToNodeStates(ns), mutation)
        return nodeStatesToFlow(next)
      })
      markDirty()
    })
  }, [setNodes, markDirty])

  // Host connection-approval gate: when a client finishes the handshake, prompt the host to
  // verify the SAS and allow/deny before any remote pty/fs RPC is served.
  useEffect(() => {
    return window.nodeTerminal.remoteHost.onPeerPending((info) => setPendingPeer(info))
  }, [])

  // Record an undo snapshot when the canvas settles (debounced; skips drag frames/loads).
  useEffect(() => {
    if (loadingRef.current) {
      committedRef.current = nodes
      return
    }
    if (draggingRef.current) return
    const t = setTimeout(() => {
      if (nodes !== committedRef.current) {
        pastRef.current.push(committedRef.current)
        if (pastRef.current.length > 100) pastRef.current.shift()
        futureRef.current = []
        committedRef.current = nodes
        bumpHist((v) => v + 1)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [nodes])

  const undo = useCallback(() => {
    if (!pastRef.current.length) return
    const prev = pastRef.current.pop() as CanvasNode[]
    futureRef.current.push(committedRef.current)
    committedRef.current = prev
    nodesRef.current = prev
    setNodes(prev)
    setDirty(true)
    bumpHist((v) => v + 1)
  }, [setNodes])

  const redo = useCallback(() => {
    if (!futureRef.current.length) return
    const next = futureRef.current.pop() as CanvasNode[]
    pastRef.current.push(committedRef.current)
    committedRef.current = next
    nodesRef.current = next
    setNodes(next)
    setDirty(true)
    bumpHist((v) => v + 1)
  }, [setNodes])

  // Cmd/Ctrl+Z = undo, Cmd/Ctrl+Shift+Z or Cmd/Ctrl+Y = redo (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const k = e.key.toLowerCase()
      if (k !== 'z' && k !== 'y') return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      e.preventDefault()
      if (k === 'y' || (k === 'z' && e.shiftKey)) redo()
      else undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undo, redo])

  // ---- canvas interactions ----
  const handleNodesChange: typeof onNodesChange = useCallback(
    (changes) => {
      // Ephemeral nodes (subagent / loop) live outside the managed state. Persist their drag
      // positions to the agent-nodes store; drop their other changes from the managed updater.
      const eph = useAgentNodes.getState().byId
      const isEph = (id: string) => id in eph || id.startsWith('loop-')
      const managed = changes.filter((c) => {
        if ('id' in c && isEph(c.id)) {
          if (c.type === 'position' && c.position) useAgentNodes.getState().setPosition(c.id, c.position)
          else if (c.type === 'select') setEphSel((prev) => ({ ...prev, [c.id]: c.selected }))
          else if (c.type === 'dimensions' && c.dimensions && c.resizing)
            useAgentNodes.getState().setSize(c.id, c.dimensions)
          return false
        }
        return true
      })
      onNodesChange(managed)
      if (managed.some((c) => c.type !== 'select')) markDirty()
    },
    [onNodesChange, markDirty]
  )

  // Resolve a node's agent id, with a tags fallback for not-yet-migrated legacy nodes.
  const agentIdOf = useCallback((id: string): AgentId | undefined => {
    const n = nodesRef.current.find((x) => x.id === id)
    if (!n || n.type !== 'terminal') return undefined
    return (
      (n.data.agentId as AgentId | undefined) ??
      (((n.data.tags as string[]) ?? []).includes('claude') ? 'claude' : undefined)
    )
  }, [])

  // Endpoint descriptor for classifyLink: node kind + whether it's a context-link-capable
  // agent session (claude/codex/gemini). Null when the node doesn't exist.
  const linkEndpointOf = useCallback(
    (id: string): LinkEndpoint | null => {
      const n = nodesRef.current.find((x) => x.id === id)
      if (!n) return null
      const a = agentIdOf(id)
      return { kind: n.type ?? 'terminal', contextCapable: !!a && canContextLink(a) }
    },
    [agentIdOf]
  )

  // Draw a link: context (two agent nodes read each other) or note (sticky text becomes
  // the terminal's context).
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      const se = linkEndpointOf(c.source)
      const te = linkEndpointOf(c.target)
      if (!se || !te) return
      const kind = classifyLink(se, te)
      if (!kind) return
      // Note edges are stored sticky→terminal regardless of drag direction, so styling and
      // the link map can key off "source is sticky".
      const source = kind === 'note' && te.kind === 'sticky' ? c.target : c.source
      const target = source === c.source ? c.target : c.source
      // No duplicate link (in either direction).
      const exists = linkEdgesRef.current.some(
        (e) =>
          (e.source === source && e.target === target) ||
          (e.source === target && e.target === source)
      )
      if (exists) return
      setLinkEdges((es) =>
        addEdge({ id: `bridge-${source}-${target}`, source, target, type: 'default' }, es)
      )
      markDirty()
      const status = useAgentStatus.getState().byId
      const titleOf = (id: string) =>
        (nodes.find((n) => n.id === id)?.data.title as string) || 'a linked node'
      if (kind === 'context') {
        // Discovery: tell each idle endpoint it is now linked (skip a node mid-turn so we
        // don't interrupt it). Claude gets the skill pointer; codex/gemini get the CLI inline.
        const note = async (selfId: string, otherId: string) => {
          if (status[selfId]?.state === 'working') return
          const { shimPath } = await window.nodeTerminal.contextLink.info()
          void window.nodeTerminal.pty.sendText(
            selfId,
            buildContextLinkNote(agentIdOf(selfId), titleOf(otherId), shimPath)
          )
        }
        void note(source, target)
        void note(target, source)
        return
      }
      // Note link: push the note text once into the terminal — agent sessions only.
      // pty.sendText appends Enter, so pushing into a plain shell would EXECUTE the text
      // as a command; plain terminals get the link file but no injection.
      if (!agentIdOf(target)) return
      if (status[target]?.state === 'working') return
      const sticky = nodes.find((n) => n.id === source)
      const msg = buildNotePushMessage(
        (sticky?.data.title as string) || 'Note',
        (sticky?.data.text as string) ?? '',
        agentIdOf(target)
      )
      if (msg) void window.nodeTerminal.pty.sendText(target, msg)
    },
    [linkEndpointOf, agentIdOf, setLinkEdges, markDirty, nodes]
  )

  // Double-click a context link to remove it (ephemeral subagent/loop edges are left alone).
  const onEdgeDoubleClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      // Control ropes are removable the same way as context links (ephemeral edges are not).
      if (controlEdgesRef.current.some((b) => b.id === edge.id)) {
        setControlEdges((es) => es.filter((b) => b.id !== edge.id))
        markDirty()
        return
      }
      if (!linkEdgesRef.current.some((b) => b.id === edge.id)) return
      setLinkEdges((es) => es.filter((b) => b.id !== edge.id))
      markDirty()
    },
    [setLinkEdges, markDirty]
  )

  // Route edge changes (selection) to the right store: `ctrl-` ids are control ropes (local
  // state), everything else is a context link. Ephemeral subagent/loop edges emit no changes
  // worth applying — applyEdgeChanges on unknown ids is a no-op either way.
  const handleEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      const rope: EdgeChange[] = []
      const link: EdgeChange[] = []
      for (const c of changes) ('id' in c && String(c.id).startsWith('ctrl-') ? rope : link).push(c)
      if (rope.length) setControlEdges((es) => applyEdgeChanges(rope, es))
      if (link.length) onLinkEdgesChange(link)
    },
    [onLinkEdgesChange]
  )

  // Prune ropes whose endpoints were deleted (mirrors the context-link pruning below).
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id))
    setControlEdges((es) => {
      const valid = es.filter((e) => ids.has(e.source) && ids.has(e.target))
      return valid.length === es.length ? es : valid
    })
  }, [nodes])

  // Rewrite link files when a linked node's session starts/changes: main resolves
  // codex/gemini transcripts by sessionId, so a session that appears after the edge was
  // drawn must trigger a rewrite. Primitive signature, not the byId map (see loopSig).
  const linkSessionSig = useAgentStatus((s) => {
    let sig = ''
    for (const e of linkEdges) {
      sig += (s.byId[e.source]?.sessionId ?? '') + '|' + (s.byId[e.target]?.sessionId ?? '') + '|'
    }
    return sig
  })

  // Prune links whose endpoints were deleted, then push the link map to main (debounced) so
  // it can rewrite the per-node link files the context CLI reads.
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id))
    const valid = linkEdges.filter((e) => ids.has(e.source) && ids.has(e.target))
    if (valid.length !== linkEdges.length) {
      setLinkEdges(valid)
      return // re-runs with the pruned set
    }
    const infoOf = (id: string) => {
      const n = nodes.find((nn) => nn.id === id)
      const sticky = n?.type === 'sticky'
      const agentId = sticky ? undefined : agentIdOf(id)
      return {
        id,
        title: (n?.data.title as string) || id,
        cwd: (n?.data.cwd as string) || '',
        note: sticky ? ((n?.data.text as string) ?? '') : undefined,
        sticky,
        agentId,
        sessionId: agentId ? useAgentStatus.getState().byId[id]?.sessionId : undefined,
        accountId: sticky ? undefined : ((n?.data.accountId as string) || undefined)
      }
    }
    const map = buildLinkMap(valid, infoOf)
    const t = setTimeout(() => void window.nodeTerminal.contextLink.setLinks(map), 150)
    return () => clearTimeout(t)
    // linkSessionSig is read only as an effect trigger — infoOf re-reads sessionIds via getState().
  }, [linkEdges, nodes, setLinkEdges, agentIdOf, linkSessionSig])

  // Reflect Claude nodes with unread output as a macOS Dock badge count (across all projects).
  // Subscribes to the derived count (a primitive), not the byId map, for the same reason as
  // loopSig above — state flips must not re-render the canvas.
  const unreadCount = useAgentStatus((s) => {
    let count = 0
    for (const st of Object.values(s.byId)) if (st?.unread) count++
    return count
  })
  useEffect(() => {
    window.nodeTerminal.setBadgeCount(unreadCount)
  }, [unreadCount])

  // Feed per-session context-window fill from main into the transient store.
  useEffect(() => {
    return window.nodeTerminal.context.onUpdate((u) => useContextWindow.getState().set(u))
  }, [])

  // Prevent a stray file drop (outside a terminal body) from navigating the whole window to
  // the dropped file. Terminal nodes handle their own drop and stopPropagation, so this only
  // catches drops on empty canvas / other UI.
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault()
    }
    window.addEventListener('dragover', prevent)
    window.addEventListener('drop', prevent)
    return () => {
      window.removeEventListener('dragover', prevent)
      window.removeEventListener('drop', prevent)
    }
  }, [])

  // Zoom on Cmd/Ctrl+wheel and trackpad pinch (ctrl+wheel), handled in one capture-phase
  // listener for the whole canvas — so it works on the open canvas, over a selected node, and
  // even over a *focused* terminal (whose `nowheel` would otherwise route the wheel into xterm
  // scrollback). We intercept (preventDefault + stopPropagation) before xterm sees it, then
  // zoom to the cursor. React Flow's own zoomOnPinch / zoomActivationKeyCode are disabled so
  // this is the single source of zoom (no double-zoom on the open canvas).
  //
  // With settings.wheelZoom on, a PLAIN wheel zooms too (mouse-first workflow; scroll-to-pan
  // is disabled on <ReactFlow> in that mode) — except inside a `nowheel` node body (focused
  // xterm scrollback, Monaco, markdown/chat panes), which keeps its own scrolling. The hover
  // guard overlay is NOT nowheel, so an unfocused terminal still zooms under the cursor.
  const wheelZoom = settings.wheelZoom
  useEffect(() => {
    const wrap = flowWrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) {
        // pinch (ctrl+wheel) / Cmd/Ctrl+scroll always zoom; plain wheel only when opted in
        if (!wheelZoom) return
        if ((e.target as HTMLElement | null)?.closest('.nowheel')) return
      }
      e.preventDefault()
      e.stopPropagation()
      const { x, y, zoom } = getViewport()
      const rect = wrap.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      // Cap a single event's influence so a chunky mouse-wheel tick doesn't jump zoom levels.
      const d = Math.max(-50, Math.min(50, e.deltaY))
      const next = Math.min(2, Math.max(0.01, zoom * Math.exp(-d * 0.01)))
      if (next === zoom) return
      const k = next / zoom
      setViewport({ x: px - (px - x) * k, y: py - (py - y) * k, zoom: next })
    }
    wrap.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => wrap.removeEventListener('wheel', onWheel, { capture: true })
  }, [getViewport, setViewport, wheelZoom])

  /** Flow-space point at the center of the visible canvas (for dock-added nodes). */
  const viewCenter = useCallback(() => {
    const rect = flowWrapRef.current?.getBoundingClientRect()
    if (!rect) return undefined
    return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  }, [screenToFlowPosition])

  // cwd for a node being created INTO a group: prefer the group's bound worktree path,
  // then its default cwd, else undefined (caller falls back to the project cwd).
  const cwdForNewNodeIn = useCallback((parentId: string | undefined): string | undefined => {
    if (!parentId) return undefined
    const parent = nodesRef.current.find((n) => n.id === parentId)
    return parent?.data.worktree?.path || parent?.data.cwd || undefined
  }, [])

  // Reparent a freshly-created node into a group (parentId + extent 'parent', position made
  // relative to the group frame). Mirrors how `groupSelectedNodes` parents its children.
  const parentInto = useCallback((node: CanvasNode, groupId: string): CanvasNode => {
    const group = nodesRef.current.find((n) => n.id === groupId)
    if (!group) return node
    return {
      ...node,
      parentId: groupId,
      extent: 'parent' as const,
      position: { x: node.position.x - group.position.x, y: node.position.y - group.position.y }
    }
  }, [])

  const addTerminal = useCallback(
    (center?: { x: number; y: number }, initialCommand?: string, groupId?: string) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const cwd = cwdForNewNodeIn(groupId) ?? project?.cwd
      setNodes((ns) => {
        // In an SSH project the node is stamped remote (runs over the project's master); the
        // factory takes the project's ssh and roots the terminal at its remoteCwd.
        const node = createTerminalNode(ns.length, cwd, center ?? viewCenter(), initialCommand, project?.ssh)
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter, cwdForNewNodeIn, parentInto]
  )

  /** Open a new terminal that runs a command on start (e.g. gh auth login). */
  const runInTerminal = useCallback((cmd: string) => addTerminal(undefined, cmd), [addTerminal])

  /** Open a terminal node bound to a remote host (RemoteTransport) for a live relay connection. */
  // Tear down the active remote mirror: hide the view and disconnect the relay connection (ends
  // the host<->client bridge; the host-side tmux sessions survive). Safe to call when none active.
  const disconnectRemote = useCallback(() => {
    setRemoteConnId((id) => {
      if (id) void window.nodeTerminal.remoteClient.disconnect(id)
      return null
    })
  }, [])

  // Mount the host mirror for an already-established connection. Wires `onClosed` so a dropped
  // host/relay tears the view down without leaking the listener.
  const mountRemoteMirror = useCallback((connectionId: string) => {
    setRemoteConnId(connectionId)
  }, [])

  // "New Remote Connection" entry point (dock / palette): paste a host's pairing offer, connect,
  // and open the live mirror over the local canvas. This is the primary remote entry (it replaces
  // B4's lone remote-terminal-on-connect flow).
  const connectRemote = useCallback(async () => {
    const offer = (await promptDialog({ message: "Paste the host's pairing code:" }))?.trim()
    if (!offer) return
    try {
      const connectionId = await window.nodeTerminal.remoteClient.connect(offer)
      mountRemoteMirror(connectionId)
    } catch (err) {
      window.alert(`Could not connect: ${(err as Error).message}`)
    }
  }, [mountRemoteMirror])

  /** Open a file as a code editor node on the canvas. `sshFs` must be passed explicitly by the
   *  caller: only genuinely-remote, Explorer-opened files in an SSH project pass `true`; native
   *  dialog / quick-open paths are LOCAL and stay local (so their ⌘S never writes to the host). */
  const openFile = useCallback(
    (filePath: string, center?: { x: number; y: number }, sshFs?: boolean) => {
      setNodes((ns) => [
        ...ns,
        isVideoFile(filePath)
          ? createVideoNode(ns.length, filePath, center ?? viewCenter())
          : createEditorNode(ns.length, filePath, center ?? viewCenter(), sshFs)
      ])
      markDirty()
    },
    [setNodes, markDirty, viewCenter]
  )

  // Load the quick-open file index when the palette opens.
  useEffect(() => {
    if (!paletteOpen) return
    const cwd = useProjects.getState().getProject(activeProjectId ?? '')?.cwd
    if (!cwd) {
      setFileIndex([])
      return
    }
    let cancelled = false
    void window.nodeTerminal.files.quickOpen(cwd).then((files) => {
      if (!cancelled) setFileIndex(prepareQuickOpenFiles(files))
    })
    return () => {
      cancelled = true
    }
  }, [paletteOpen, activeProjectId])

  /** Open a quick-open file result by root-relative path: editor node for text/images,
   *  OS default app for binaries (e.g. .dmg). */
  const openProjectFile = useCallback(
    (relPath: string) => {
      const cwd = useProjects.getState().getProject(activeProjectId ?? '')?.cwd
      if (!cwd) return
      // relPath comes from the trusted local file index (always cwd-relative), so the
      // `cwd + relPath` join needs no traversal guard in v1; a future remote/untrusted source would.
      const abs = `${cwd.replace(/\/$/, '')}/${relPath}`
      if (opensInEditor(relPath)) openFile(abs)
      else window.nodeTerminal.shell.openPath(abs)
    },
    [activeProjectId, openFile]
  )

  /** Reveal a file in the Explorer drawer: open the drawer and hand it the (relative) path.
   *  Each call bumps a nonce so revealing the same file twice still re-fires the effect. */
  const revealProjectFile = useCallback((relPath: string) => {
    setExplorerOpen(true)
    setReveal((r) => ({ path: relPath, nonce: (r?.nonce ?? 0) + 1 }))
  }, [])

  /** Open a git diff editor node for a changed file (from Source Control). */
  const openDiff = useCallback(
    (relPath: string, staged: boolean) => {
      const project = useProjects.getState().getProject(activeProjectId)
      // SSH project: the diff node operates on the remote repo, so its cwd must be the exact
      // remoteCwd (the git remote registry matches by exact string; same value passed to connect).
      const cwd = project?.ssh?.remoteCwd ?? project?.cwd
      if (!cwd) return
      setNodes((ns) => [...ns, createDiffNode(ns.length, cwd, relPath, staged, viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter]
  )

  /** Open a parent↔commit diff node for a file from the history graph. */
  const openCommitDiff = useCallback(
    (relPath: string, commitOid: string) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const cwd = project?.ssh?.remoteCwd ?? project?.cwd
      if (!cwd) return
      setNodes((ns) => [...ns, createDiffNode(ns.length, cwd, relPath, false, viewCenter(), commitOid)])
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter]
  )

  /** Open a Claude node seeded with a commit-explanation prompt. */
  const explainCommit = useCallback(
    (prompt: string) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const account = resolveNewNodeAccount(
        undefined,
        project,
        useSettings.getState().settings.claudeAccounts
      )
      setNodes((ns) => [
        ...ns,
        createAgentNode('claude', ns.length, project?.cwd, viewCenter(), prompt, undefined, account)
      ])
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter]
  )

  /** Pick a file via the native dialog and open it as an editor node. */
  const openFileDialog = useCallback(
    async (center?: { x: number; y: number }) => {
      const f = await window.nodeTerminal.dialog.selectFile()
      if (f) openFile(f, center)
    },
    [openFile]
  )

  /** Open the clone dialog; project creation happens in onRepoCloned below. */
  const cloneRepo = useCallback(() => setCloneDialogOpen(true), [])

  const onRepoCloned = useCallback(
    (clonedPath: string, name: string) => {
      commitActiveToStore()
      const project = useProjects.getState().addProject(name, clonedPath)
      useProjects.getState().setActive(project.id)
      // The welcome screen stays up behind the clone dialog; dismiss it now that a
      // project actually exists (no-op when the dialog was opened elsewhere).
      setWelcomeOpen(false)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  const addSticky = useCallback(
    (center?: { x: number; y: number }, groupId?: string) => {
      setNodes((ns) => {
        const node = createStickyNode(ns.length, center ?? viewCenter())
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [setNodes, markDirty, viewCenter, parentInto]
  )

  const addDino = useCallback(
    (center?: { x: number; y: number }) => {
      // Seed with the project record, maxed with any live dino nodes (pre-record projects
      // only carry the score in node data).
      const record = useProjects.getState().getProject(activeProjectId)?.dinoHighScore ?? 0
      setNodes((ns) => {
        const liveBest = Math.max(
          record,
          ...ns.filter((n) => n.type === 'dino').map((n) => (n.data.highScore as number) ?? 0)
        )
        return [...ns, createDinoNode(ns.length, center ?? viewCenter(), liveBest)]
      })
      markDirty()
    },
    [setNodes, markDirty, viewCenter, activeProjectId]
  )

  const addWebView = useCallback(
    async (center?: { x: number; y: number }) => {
      const input = await promptDialog({ message: 'Open web view — enter a URL:' })
      const url = input?.trim()
      if (!url) return
      setNodes((ns) => [...ns, createWebNode(ns.length, { url }, center ?? viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, viewCenter]
  )

  const addBrowser = useCallback(
    (center?: { x: number; y: number }) => {
      // Open a blank browser node — the user types the URL in the node's own address bar (like a
      // browser's new tab). We deliberately don't use window.prompt: Electron doesn't support it
      // (it throws "prompt() is and will not be supported"), and a browser node doesn't need it.
      setNodes((ns) => [...ns, createBrowserNode(ns.length, '', center ?? viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, viewCenter]
  )

  const addChatNode = useCallback(
    (center?: { x: number; y: number }, accountId?: string, groupId?: string) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const cwd = cwdForNewNodeIn(groupId) ?? project?.cwd
      const account = resolveNewNodeAccount(
        accountId,
        project,
        useSettings.getState().settings.claudeAccounts
      )
      setNodes((ns) => {
        const node = createChatNode(ns.length, cwd, center ?? viewCenter(), undefined, account)
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter, cwdForNewNodeIn, parentInto]
  )

  // Task 6: the Settings → Accounts "Add account" flow dispatches 'nodeterm:add-account-login'
  // to open a terminal node running `claude /login` under the new account's config dir.
  useEffect(() => {
    const onAddAccountLogin = (ev: Event): void => {
      const detail = (ev as CustomEvent<{ accountId: string; remote?: boolean; host?: string }>)
        .detail
      const accountId = detail?.accountId
      if (!accountId) return
      // A REMOTE account logs in ON ITS HOST: resolve the ssh binding BY HOST (from the event),
      // NOT from the active project — Retry can fire from any project, so the active one may be
      // local or a different host. Match against CONNECTED projects only (live ControlMaster in
      // useSshConn). If none matches, do NOT spawn a node: a local `claude /login` would mutate the
      // user's SYSTEM ~/.claude login while waitLogin polls the remote host forever.
      let ssh: ReturnType<typeof useProjects.getState>['projects'][number]['ssh']
      if (detail?.remote) {
        const host = detail.host
        const conn = useSshConn.getState().byProject
        const project = host
          ? useProjects
              .getState()
              .projects.find((p) => p.ssh && sshHostKey(p.ssh.server) === host && conn[p.id])
          : undefined
        if (!project) return // defensive: mismatched/disconnected remote login — never spawn locally
        ssh = project.ssh
      }
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { ...createAccountLoginNode(accountId, ns.length, viewCenter(), ssh), selected: true }
      ])
      markDirty()
      // The event fires from the full-screen Settings overlay — close it so the user actually
      // sees the login node (it spawns at viewCenter, selected). The defensive return above
      // keeps Settings open when nothing was spawned (mismatched/disconnected remote login).
      setSettingsOpen(false)
    }
    window.addEventListener('nodeterm:add-account-login', onAddAccountLogin)
    return () => window.removeEventListener('nodeterm:add-account-login', onAddAccountLogin)
    // Resolves the ssh binding by host at fire time (reads stores directly), so no project dep.
  }, [setNodes, markDirty, viewCenter])

  // Resolve the system account's email once, so context menus (built via getState) can label
  // the "System account" entry with it.
  useEffect(() => useSystemAccount.getState().ensure(), [])

  const addAgentNode = useCallback(
    (agentId: AgentId, center?: { x: number; y: number }, groupId?: string, accountId?: string) => {
      const project = useProjects.getState().getProject(activeProjectId)
      const cwd = cwdForNewNodeIn(groupId) ?? project?.cwd
      // Funnel through resolveNewNodeAccount so the project default applies even without an
      // explicit pick. The factory drops the account for non-claude agents.
      const account = resolveNewNodeAccount(
        accountId,
        project,
        useSettings.getState().settings.claudeAccounts
      )
      setNodes((ns) => {
        const node = createAgentNode(
          agentId,
          ns.length,
          cwd,
          center ?? viewCenter(),
          undefined,
          project?.ssh,
          account
        )
        return [...ns, groupId ? parentInto(node, groupId) : node]
      })
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter, cwdForNewNodeIn, parentInto]
  )

  // Open a terminal node that ssh's into a saved server. `screenPos` (a pane/dock cursor) is
  // converted to a flow position; otherwise the node lands at the view center. The new node is
  // selected (and others deselected) so it's the active focus right away.
  const addSshTerminal = useCallback(
    (server: SshServer, screenPos?: { x: number; y: number }) => {
      const at = screenPos ? screenToFlowPosition(screenPos) : viewCenter()
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { ...createSshTerminalNode(server, ns.length, at), selected: true }
      ])
      markDirty()
    },
    [setNodes, markDirty, screenToFlowPosition, viewCenter]
  )

  // Pro-gated entry to the SSH server picker: free users get the upgrade dialog instead.
  const openRemotePicker = useCallback((screenPos: { x: number; y: number }) => {
    requireProOr('Remote SSH terminals', () => setRemotePicker(screenPos))
  }, [])

  // ⌘T = new terminal, ⌘⇧C = new default agent (ignored while typing in a field/terminal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const k = e.key.toLowerCase()
      if (k === 't' && !e.shiftKey) {
        e.preventDefault()
        addTerminal()
      } else if (k === 'c' && e.shiftKey) {
        e.preventDefault()
        addAgentNode(useSettings.getState().settings.defaultAgent)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addTerminal, addAgentNode])

  // When a remote connection is established (from Settings' "Connect to a host"), open the live
  // mirror of the host's canvas. Dispatched as a window event so Settings doesn't need a Canvas
  // reference. This replaces B4's lone-remote-terminal behavior as the primary remote entry.
  useEffect(() => {
    const onOpenRemote = (e: Event) => {
      const connectionId = (e as CustomEvent<{ connectionId: string }>).detail?.connectionId
      if (connectionId) mountRemoteMirror(connectionId)
    }
    window.addEventListener('nodeterm:open-remote-terminal', onOpenRemote)
    return () => window.removeEventListener('nodeterm:open-remote-terminal', onOpenRemote)
  }, [mountRemoteMirror])

  // Tear the mirror down if the host/relay drops the active connection.
  useEffect(() => {
    if (!remoteConnId) return
    return window.nodeTerminal.remoteClient.onClosed(remoteConnId, () => {
      setRemoteConnId((id) => (id === remoteConnId ? null : id))
    })
  }, [remoteConnId])

  // ---- multi-node actions (context menu) ----
  const deleteNodes = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      nodesRef.current.forEach((n) => {
        if (!set.has(n.id)) return
        // Permanent delete: the upcoming unmount must dispose the xterm, not park it (the
        // session is being destroyed right here). Also drops an already-parked entry.
        if (n.type === 'terminal') disposeTerminalOnUnmount(n.id)
        // Remote terminals have no local persistent session — only destroy local ones.
        if (n.type === 'terminal' && !n.data.remote) transport.destroy(n.id)
        // Chat nodes: permanently kill the SDK driver + drop the live chat state. The driver
        // lives across project switches (only permanent delete kills it), so this belongs here,
        // not in node unmount.
        if (n.type === 'chat') {
          window.nodeTerminal.chat.dispose(n.id)
          useChatSessions.getState().drop(n.id)
        }
        // Permanent deletion → drop the node's persisted agent status (sessionId/session/
        // unread/loop). Node unmount no longer does this, so deletion must. The loop card's
        // UI overrides live in agentNodes and are skipped by unmount's clearForParent.
        useAgentStatus.getState().remove(n.id)
        useAgentNodes.getState().clearLoop(n.id)
      })
      // Tear down relay connections owned solely by the deleted remote node(s). The model is
      // N:1 (one connection per remote node), but dedupe defensively: only disconnect a
      // connectionId if no *surviving* remote node still uses it, so we never drop a live one.
      const deletedConns = new Set<string>()
      const survivingConns = new Set<string>()
      nodesRef.current.forEach((n) => {
        const conn = (n.data.remote as { connectionId: string } | undefined)?.connectionId
        if (!conn) return
        if (set.has(n.id)) deletedConns.add(conn)
        else survivingConns.add(conn)
      })
      deletedConns.forEach((conn) => {
        if (!survivingConns.has(conn)) void window.nodeTerminal.remoteClient.disconnect(conn)
      })
      setNodes((ns) => {
        // Free children of any deleted group back to absolute positions.
        const groupPos = new Map(
          ns.filter((n) => set.has(n.id) && n.type === 'group').map((g) => [g.id, g.position])
        )
        return ns
          .filter((n) => !set.has(n.id))
          .map((n) =>
            n.parentId && groupPos.has(n.parentId)
              ? {
                  ...n,
                  parentId: undefined,
                  extent: undefined,
                  position: {
                    x: n.position.x + groupPos.get(n.parentId)!.x,
                    y: n.position.y + groupPos.get(n.parentId)!.y
                  }
                }
              : n
          )
      })
      markDirty()
    },
    [setNodes, markDirty]
  )

  // When an account is removed in Settings, patch the ACTIVE project's live nodes (the projects
  // store only holds the other projects' serialized copies). The account's login node is
  // permanently DELETED — left alive with its accountId cleared, a cold restart would respawn
  // its `claude /login` under the SYSTEM env, where completing the OAuth silently overwrites the
  // user's ~/.claude identity (observed in the wild). Ordinary nodes just drop the accountId and
  // fall back to the system account (the missing-dir spawn fallback is safe either way).
  // Declared after deleteNodes: the dep array would hit the const's TDZ above it.
  useEffect(() => {
    const onAccountRemoved = (ev: Event): void => {
      const accountId = (ev as CustomEvent<{ accountId: string }>).detail?.accountId
      if (!accountId) return
      const loginIds = nodesRef.current
        .filter((n) => n.data.accountId === accountId && isAccountLoginNode(n.data))
        .map((n) => n.id)
      if (loginIds.length) deleteNodes(loginIds)
      setNodes((ns) =>
        ns.some((n) => n.data.accountId === accountId)
          ? ns.map((n) =>
              n.data.accountId === accountId
                ? { ...n, data: { ...n.data, accountId: undefined } }
                : n
            )
          : ns
      )
      // Schedule a workspace write: persist() re-serializes the cleared live nodes and writes
      // the whole projects store to disk, also covering AccountsSection's setState on the other
      // projects' serialized nodes + defaultAccountId. Without this, quitting right after a
      // removal would leave the dead accountId in workspace.json.
      markDirty()
    }
    window.addEventListener('nodeterm:account-removed', onAccountRemoved)
    return () => window.removeEventListener('nodeterm:account-removed', onAccountRemoved)
  }, [setNodes, markDirty, deleteNodes])

  // Delete / Backspace asks for confirmation, then deletes the selected nodes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const ids = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
      if (!ids.length) {
        // No node selected → remove any selected context link(s) / control rope(s).
        const edgeIds = linkEdgesRef.current.filter((b) => b.selected).map((b) => b.id)
        const ropeIds = controlEdgesRef.current.filter((b) => b.selected).map((b) => b.id)
        if (edgeIds.length || ropeIds.length) {
          e.preventDefault()
          if (edgeIds.length) {
            const drop = new Set(edgeIds)
            setLinkEdges((es) => es.filter((b) => !drop.has(b.id)))
          }
          if (ropeIds.length) {
            const drop = new Set(ropeIds)
            setControlEdges((es) => es.filter((b) => !drop.has(b.id)))
          }
          markDirty()
        }
        return
      }
      e.preventDefault()
      setConfirm({
        message: `Delete ${ids.length} ${ids.length > 1 ? 'nodes' : 'node'}? Open terminal sessions will end.`,
        onConfirm: () => {
          deleteNodes(ids)
          setConfirm(null)
        }
      })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [deleteNodes, setLinkEdges, markDirty])

  // Cmd/Ctrl+W (forwarded from main) closes the selected node(s) immediately, like the
  // node's × button. With nothing selected it falls back to closing the window.
  useEffect(() => {
    return window.nodeTerminal.onCloseNode(() => {
      const ids = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
      if (ids.length) deleteNodes(ids)
      else window.nodeTerminal.closeWindow()
    })
  }, [deleteNodes])

  const groupSelection = useCallback(
    (ids: string[]) => {
      const groupCount = nodesRef.current.filter((n) => n.type === 'group').length
      setNodes((ns) => groupSelectedNodes(ns as CanvasNode[], ids, groupCount))
      markDirty()
    },
    [setNodes, markDirty]
  )

  // Detach single nodes from their group frame (the frame and its other children stay).
  // Counterpart of drag-into-group / `ungroup` (which dissolves the whole frame).
  const removeFromGroup = useCallback(
    (ids: string[]) => {
      setNodes((ns) => {
        let next = ns as CanvasNode[]
        for (const nid of ids) next = reparentNode(next, nid, null)
        return next
      })
      markDirty()
    },
    [setNodes, markDirty]
  )

  const ungroup = useCallback(
    (groupId: string) => {
      setNodes((ns) => ungroupNodes(ns as CanvasNode[], groupId))
      markDirty()
    },
    [setNodes, markDirty]
  )

  const groupHasWorktree = useCallback(
    (groupId: string) => !!nodesRef.current.find((n) => n.id === groupId)?.data.worktree,
    []
  )

  const bindGroupToWorktree = useCallback((groupId: string) => setBindTarget(groupId), [])

  const confirmBind = useCallback(
    async (v: BindWorktreeValue) => {
      const git = window.nodeTerminal.git
      const res = await git.worktreeAdd(v.repoPath, v.path, v.branch, v.baseRef, v.mode === 'new')
      if (!res.ok) {
        window.alert(res.message)
        return
      }
      setNodes((ns) =>
        ns.map((n) =>
          n.id === bindTarget
            ? {
                ...n,
                data: {
                  ...n.data,
                  worktree: {
                    repoPath: v.repoPath,
                    branch: v.branch,
                    baseRef: v.baseRef,
                    path: v.path,
                    createdByApp: true
                  }
                }
              }
            : n
        )
      )
      setBindTarget(null)
      markDirty()
    },
    [bindTarget, setNodes, markDirty]
  )

  // Ask-first worktree removal (Task 9). Gather any uncommitted-work info, then open a safety
  // dialog before doing anything destructive. GitStatus has no `files` field — the dirty count
  // is staged + unstaged changes.
  const requestRemoveWorktree = useCallback(async (groupId: string) => {
    const wt = nodesRef.current.find((n) => n.id === groupId)?.data.worktree
    if (!wt) return
    const status = await window.nodeTerminal.git.status(wt.path)
    const dirtyCount = (status?.staged.length ?? 0) + (status?.changes.length ?? 0)
    const warning = dirtyCount > 0 ? `${dirtyCount} uncommitted file(s) in the worktree.` : ''
    setRemoveTarget({ groupId, warning })
  }, [])

  // Confirmed removal: process BEFORE git. End each child terminal's tmux session first so git
  // never touches a directory with live processes inside it, then remove the worktree + branch.
  // worktreeRemove uses `git branch -d`, which refuses to delete an unmerged branch; that failure
  // is swallowed, so the worktree directory is removed, the branch is kept, and res.ok is still
  // true — the binding is cleared either way (res.ok is false only if the worktree remove fails).
  const confirmRemoveWorktree = useCallback(async () => {
    const t = removeTarget
    if (!t) return
    const wt = nodesRef.current.find((n) => n.id === t.groupId)?.data.worktree
    if (!wt) {
      setRemoveTarget(null)
      return
    }
    // 1) Kill the group's terminals' sessions BEFORE git touches the directory.
    const childIds = nodesRef.current
      .filter((n) => n.parentId === t.groupId && n.type === 'terminal')
      .map((n) => n.id)
    for (const id of childIds) transport.destroy(id)
    // 2) Remove the worktree (and try to delete its branch). The branch delete uses `git -d`,
    //    which refuses unmerged branches; that refusal is swallowed (branch kept), so res.ok is
    //    false only when the worktree-directory removal itself fails.
    const res = await window.nodeTerminal.git.worktreeRemove(wt.repoPath, wt.path, true)
    if (!res.ok) {
      window.alert(res.message)
      setRemoveTarget(null)
      return
    }
    // 3) Clear the binding from the group node.
    setNodes((ns) =>
      ns.map((n) => (n.id === t.groupId ? { ...n, data: { ...n.data, worktree: undefined } } : n))
    )
    setRemoveTarget(null)
    markDirty()
  }, [removeTarget, setNodes, markDirty])

  // Worktree action dispatcher for GroupNode's header chip. Structured as a switch so the
  // merge / remove teardown actions (Tasks 8 & 9) slot in as new cases. `unbind` forgets the
  // binding without touching disk; `merge` merges to base; `remove` opens the safety dialog.
  const onWorktreeAction = useCallback(
    async (groupId: string, action: 'merge' | 'remove' | 'unbind') => {
      switch (action) {
        case 'unbind':
          setNodes((ns) =>
            ns.map((n) =>
              n.id === groupId ? { ...n, data: { ...n.data, worktree: undefined } } : n
            )
          )
          markDirty()
          break
        case 'merge': {
          const wt = nodesRef.current.find((n) => n.id === groupId)?.data.worktree
          if (!wt) return
          const res = await window.nodeTerminal.git.worktreeMerge(wt.repoPath, wt.branch, wt.baseRef)
          window.alert(res.message) // success or the blocked/conflict reason
          break
        }
        case 'remove':
          void requestRemoveWorktree(groupId)
          break
        default:
          break
      }
    },
    [setNodes, markDirty, requestRemoveWorktree]
  )

  // Bridge the worktree-action handler to GroupNode (which React Flow instantiates itself).
  useEffect(() => {
    setWorktreeActionHandler(onWorktreeAction)
    return () => setWorktreeActionHandler(null)
  }, [onWorktreeAction])

  // Move an existing terminal into its group's worktree. The "↪" header action requests it;
  // confirming respawns the node's session in the worktree cwd. We bump `respawnNonce` (a
  // transient, non-persisted trigger) so TerminalNode's session-creation effect re-runs —
  // its cleanup kills the old tmux session (same node id = same target) and create() spawns a
  // fresh one with the new cwd. Changing cwd alone wouldn't re-run that `[respawnNonce]` effect.
  const requestMoveIntoWorktree = useCallback((nodeId: string) => setMoveTarget(nodeId), [])

  const confirmMoveIntoWorktree = useCallback(() => {
    const id = moveTarget
    setMoveTarget(null)
    if (!id) return
    const node = nodesRef.current.find((n) => n.id === id)
    const parent = nodesRef.current.find((p) => p.id === node?.parentId)
    const wtPath = parent?.data.worktree?.path as string | undefined
    if (!node || node.data.remote || !wtPath || node.data.cwd === wtPath) return
    // Permanently end the old tmux session (destroy, not kill) so the respawned create() opens
    // a fresh session in the new cwd instead of reattaching to the existing `nt-<id>` session
    // (which would keep the old working directory). The node id / persistKey is unchanged.
    transport.destroy(id)
    setNodes((ns) =>
      ns.map((n) =>
        n.id === id
          ? {
              ...n,
              data: {
                ...n.data,
                cwd: wtPath,
                respawnNonce: ((n.data.respawnNonce as number | undefined) ?? 0) + 1
              }
            }
          : n
      )
    )
    markDirty()
  }, [moveTarget, setNodes, markDirty])

  // Bridge the move-into-worktree handler to TerminalNode (React Flow owns the instances).
  useEffect(() => {
    setMoveIntoWorktreeHandler(requestMoveIntoWorktree)
    return () => setMoveIntoWorktreeHandler(null)
  }, [requestMoveIntoWorktree])

  const toggleMarkdown = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      setNodes((ns) =>
        ns.map((n) =>
          set.has(n.id) && n.type === 'terminal'
            ? { ...n, data: { ...n.data, mdMode: !n.data.mdMode } }
            : n
        )
      )
    },
    [setNodes]
  )

  const duplicateNodes = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      setNodes((ns) => {
        const copies = ns.filter((n) => set.has(n.id)).map((n) => duplicateNode(n))
        return [...ns.map((n) => ({ ...n, selected: false })), ...copies]
      })
      markDirty()
    },
    [setNodes, markDirty]
  )

  // Run Claude's /branch in this node, then open a new node that resumes the original
  // conversation (claude -r <ORIGINAL_ID>). The source node stays on the new branch.
  // We already know the current session id from the hooks; only fall back to parsing the
  // terminal output if it's unknown.
  const branchClaude = useCallback(
    async (nodeId: string, opts?: { interactive?: boolean }): Promise<{ ok: boolean; error?: string; newNodeId?: string }> => {
      const source = nodesRef.current.find((n) => n.id === nodeId) as CanvasNode | undefined
      if (!source) return { ok: false, error: `no node with id ${nodeId}` }
      const known = useAgentStatus.getState().byId[nodeId]?.sessionId
      let originalId = known
      if (known) {
        await window.nodeTerminal.pty.sendText(nodeId, '/branch')
      } else {
        const res = await branchClaudeSession(nodeId)
        if (!res.ok || !res.originalId) {
          const error = res.error ?? 'Branch failed.'
          // The error dialog is for humans; agent-CLI calls get the error in the reply instead.
          if (opts?.interactive !== false) {
            setConfirm({ message: error, onConfirm: () => setConfirm(null) })
          }
          return { ok: false, error }
        }
        originalId = res.originalId
      }
      const copy = duplicateNode(source)
      copy.data = {
        ...copy.data,
        initialCommand: `${claudeLaunchCommand()} -r ${originalId}`,
        title: `${source.data.title} (original)`
      }
      copy.position = {
        x: source.position.x + ((source.width as number) ?? 600) + 32,
        y: source.position.y
      }
      copy.selected = true
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), copy])
      markDirty()
      return { ok: true, newNodeId: copy.id }
    },
    [setNodes, markDirty]
  )

  // Transfer this agent's full conversation to a different agent. We render the source
  // agent's native transcript to a handoff file (main) and open a target node that reads it
  // and continues. The source node stays. Mirrors branchClaude's placement.
  const transferConversation = useCallback(
    async (sourceNodeId: string, targetAgentId: AgentId) => {
      const source = nodesRef.current.find((n) => n.id === sourceNodeId) as CanvasNode | undefined
      if (!source) return
      const sourceAgentId = source.data.agentId
      const sessionId = useAgentStatus.getState().byId[sourceNodeId]?.sessionId
      if (!sourceAgentId || !sessionId) {
        setConfirm({
          message: 'Conversation not ready to transfer yet.',
          onConfirm: () => setConfirm(null)
        })
        return
      }
      const res = await window.nodeTerminal.handoff.build(
        sessionId,
        sourceAgentId,
        sourceNodeId,
        source.data.cwd,
        source.data.accountId
      )
      if ('error' in res) {
        setConfirm({ message: res.error, onConfirm: () => setConfirm(null) })
        return
      }
      const prompt =
        `The file ${res.filePath} contains the COMPLETE prior conversation from a ` +
        `${sourceAgentId} session, including every message and all tool calls and outputs. ` +
        `Read the entire file first, then continue the task from where it left off.`
      const node = createAgentNode(
        targetAgentId,
        nodesRef.current.length,
        source.data.cwd,
        undefined,
        prompt,
        undefined,
        // Inherit the source's Claude account (dropped by the factory unless the target is claude),
        // so a claude→claude transfer resumes the transcript from the right account dir.
        source.data.accountId
      )
      node.position = {
        x: source.position.x + ((source.width as number) ?? 600) + 32,
        y: source.position.y
      }
      node.selected = true
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node])
      markDirty()
    },
    [setNodes, markDirty]
  )

  const setNodesColor = useCallback(
    (ids: string[], color: string) => {
      const set = new Set(ids)
      setNodes((ns) => ns.map((n) => (set.has(n.id) ? { ...n, data: { ...n.data, color } } : n)))
      markDirty()
    },
    [setNodes, markDirty]
  )

  const alignToGrid = useCallback(
    (ids: string[]) => {
      const g = useSettings.getState().settings.gridSize || GRID
      const set = new Set(ids)
      setNodes((ns) =>
        ns.map((n) =>
          set.has(n.id)
            ? {
                ...n,
                position: {
                  x: Math.round(n.position.x / g) * g,
                  y: Math.round(n.position.y / g) * g
                }
              }
            : n
        )
      )
      markDirty()
    },
    [setNodes, markDirty]
  )

  const selectAll = useCallback(() => {
    setNodes((ns) => ns.map((n) => ({ ...n, selected: true })))
  }, [setNodes])

  const toggleCollapseNodes = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      setNodes((ns) =>
        ns.map((n) => {
          if (!set.has(n.id)) return n
          const next = !n.data.collapsed
          const expandedHeight =
            (n.data.expandedHeight as number) ?? n.measured?.height ?? (n.height as number) ?? 300
          const height = next ? COLLAPSED_HEIGHT : expandedHeight
          return {
            ...n,
            height,
            style: { ...n.style, height },
            data: { ...n.data, collapsed: next, expandedHeight }
          }
        })
      )
      markDirty()
    },
    [setNodes, markDirty]
  )

  const goToNode = useCallback(
    (node: Node) => {
      // Fit the node in view instead of centering at a fixed zoom — `zoom: max(current, 1)`
      // overshot large terminals (their body never fit the viewport). fitView sizes the zoom
      // to the node and resolves group-relative positions itself; the clamp keeps a small
      // node from filling the whole screen and a huge one from being fit microscopic.
      void fitView({
        nodes: [{ id: node.id }],
        duration: 300,
        padding: 0.2,
        minZoom: 0.25,
        maxZoom: 1.15
      })
    },
    [fitView]
  )

  const onNodeDoubleClick = useCallback(
    (_e: React.MouseEvent, node: Node) => {
      if (useSettings.getState().settings.doubleClickFocus) goToNode(node)
    },
    [goToNode]
  )

  // Cmd/Ctrl+K toggles the command palette; Cmd/Ctrl+, opens settings.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        setSettingsSection(undefined)
        setSettingsOpen(true)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        setExplorerOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault()
        toggleSessionsPin()
      } else if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setShortcutsOpen((v) => !v)
      } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'c') {
        // Copy the current page selection (e.g. markdown view) to the clipboard.
        const tag = (document.activeElement?.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea') return
        const sel = window.getSelection?.()?.toString()
        if (sel) window.nodeTerminal.clipboard.writeText(sel)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSessionsPin])

  // Apply the accent color as a CSS variable.
  useEffect(() => {
    document.documentElement.style.setProperty('--accent', settings.accent)
  }, [settings.accent])


  /** ids to act on for a node menu: the whole selection if the node is part of it, else just it. */
  const targetIds = useCallback((node: Node): string[] => {
    const selected = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
    return node.selected && selected.length > 0 ? selected : [node.id]
  }, [])

  const selectionItems = useCallback(
    (ids: string[]): MenuItem[] => [
      { type: 'label', label: ids.length > 1 ? `${ids.length} nodes` : '1 node' },
      ...((): MenuItem[] => {
        // "Group …" only when something is actually groupable (top-level, not itself a group —
        // groupSelectedNodes silently skips the rest, so the item would otherwise no-op);
        // "Remove from group" only when a target is inside a group frame (the frame stays).
        const groupable = ids.some((nid) => {
          const n = nodesRef.current.find((nd) => nd.id === nid)
          return !!n && !n.parentId && n.type !== 'group'
        })
        const parented = ids.some(
          (nid) => !!nodesRef.current.find((nd) => nd.id === nid)?.parentId
        )
        const items: MenuItem[] = []
        if (groupable)
          items.push({
            label: ids.length > 1 ? 'Group selection' : 'Group node',
            icon: <IconGroup />,
            onClick: () => groupSelection(ids)
          })
        if (parented)
          items.push({
            label: 'Remove from group',
            icon: <IconUngroup />,
            onClick: () => removeFromGroup(ids)
          })
        if (items.length) items.push({ type: 'separator' })
        return items
      })(),
      { type: 'colors', onPick: (c) => setNodesColor(ids, c) },
      { type: 'separator' },
      { label: 'Duplicate', icon: <IconDuplicate />, onClick: () => duplicateNodes(ids) },
      ...(ids.length === 1 && (() => {
        const a = agentIdOf(ids[0])
        return !!a && canBranch(a)
      })()
        ? ([
            {
              label: 'Branch conversation',
              icon: <IconBranch />,
              onClick: () => void branchClaude(ids[0])
            }
          ] as MenuItem[])
        : []),
      ...(ids.length === 1 &&
      (() => {
        const a = agentIdOf(ids[0])
        return !!a && canTransferFrom(a) && !!useAgentStatus.getState().byId[ids[0]]?.sessionId
      })()
        ? (() => {
            const src = agentIdOf(ids[0]) as AgentId
            const disabled = useSettings.getState().settings.disabledAgents
            const settings = useSettings.getState().settings
            const targets: { id: AgentId; label: string }[] = [
              ...BUILTIN_AGENT_IDS.filter((aid) => aid !== src && !disabled.includes(aid)).map(
                (aid) => ({ id: aid as AgentId, label: AGENT_CONFIG[aid].label })
              ),
              ...settings.customAgents
                .filter((c) => c.id !== src && !disabled.includes(c.id))
                .map((c) => ({ id: c.id, label: c.label }))
            ]
            return [
              { type: 'label', label: 'Transfer conversation to' },
              ...targets.map(
                (tg): MenuItem => ({
                  label: tg.label,
                  icon: <AgentIcon agentId={tg.id} />,
                  onClick: () => void transferConversation(ids[0], tg.id)
                })
              )
            ] as MenuItem[]
          })()
        : []),
      { label: 'Align to grid', icon: <IconGrid />, onClick: () => alignToGrid(ids) },
      { label: 'Collapse / Expand', icon: <IconCollapse />, onClick: () => toggleCollapseNodes(ids) },
      ...(ids.some((nid) => nodesRef.current.find((n) => n.id === nid)?.type === 'terminal')
        ? ([
            { label: 'Markdown view', icon: <IconMarkdown />, onClick: () => toggleMarkdown(ids) }
          ] as MenuItem[])
        : []),
      { type: 'separator' },
      { label: 'Delete', icon: <IconTrash />, danger: true, onClick: () => deleteNodes(ids) }
    ],
    [
      groupSelection,
      removeFromGroup,
      setNodesColor,
      duplicateNodes,
      branchClaude,
      transferConversation,
      agentIdOf,
      alignToGrid,
      toggleCollapseNodes,
      toggleMarkdown,
      deleteNodes
    ]
  )

  /** "New <agent>" / "New chat" creation entries shared by the pane and group context menus.
   *  `at` is the flow position to create at; with `groupId` the node is parented into that group. */
  const agentCreationItems = useCallback(
    (at?: { x: number; y: number }, groupId?: string): MenuItem[] => {
      const disabled = useSettings.getState().settings.disabledAgents
      // Accounts selectable in the active project: local accounts for a local project, or this
      // host's accounts for an SSH project (pending logins always excluded).
      const project = useProjects.getState().getProject(activeProjectId)
      const accounts = accountsForProject(useSettings.getState().settings.claudeAccounts, project)
      // The system entry shows the user's custom label / detected email so it stays
      // distinguishable from managed accounts (falls back to "System account").
      const systemLabel = systemAccountDisplay(
        useSettings.getState().settings.systemAccountLabel,
        useSystemAccount.getState().email
      )
      // ✓ marks what a bare "New Claude" resolves to: the project default while it still
      // exists, else the system account (mirrors resolveNewNodeAccount's stale-id guard).
      const defaultAccountId = accounts.some((a) => a.id === project?.defaultAccountId)
        ? project?.defaultAccountId
        : undefined
      const withDefaultMark = (label: string, id?: string): string =>
        id === defaultAccountId ? `${label} ✓` : label
      return [
        ...BUILTIN_AGENT_IDS.filter((aid) => !disabled.includes(aid)).map((aid): MenuItem => {
          // Claude gets an account picker submenu when ≥1 account exists; System = project
          // default (resolved). Other agents stay flat (accounts are Claude-only).
          if (aid === 'claude' && accounts.length > 0) {
            return {
              type: 'submenu',
              label: `New ${AGENT_CONFIG[aid].label}`,
              icon: <AgentIcon agentId={aid} />,
              children: [
                {
                  label: withDefaultMark(systemLabel),
                  icon: <AgentIcon agentId="claude" />,
                  onClick: () => addAgentNode('claude', at, groupId)
                },
                ...accounts.map(
                  (a): MenuItem => ({
                    label: withDefaultMark(a.label, a.id),
                    icon: <AgentIcon agentId="claude" />,
                    onClick: () => addAgentNode('claude', at, groupId, a.id)
                  })
                )
              ]
            }
          }
          return {
            label: `New ${AGENT_CONFIG[aid].label}`,
            icon: <AgentIcon agentId={aid} />,
            onClick: () => addAgentNode(aid, at, groupId)
          }
        }),
        ...useSettings
          .getState()
          .settings.customAgents.filter((c) => !disabled.includes(c.id))
          .map(
            (c): MenuItem => ({
              label: `New ${c.label}`,
              icon: <AgentIcon agentId={c.id} />,
              onClick: () => addAgentNode(c.id, at, groupId)
            })
          )
        // "New chat" is deliberately NOT here: the context menus stay session-focused; chat
        // nodes are created from the Dock + menu and the command palette.
      ]
    },
    [activeProjectId, addAgentNode]
  )

  const groupItems = useCallback(
    (groupId: string, at?: { x: number; y: number }): MenuItem[] => [
      { type: 'label', label: 'Group' },
      {
        label: 'New terminal',
        icon: <IconTerminal />,
        onClick: () => addTerminal(at, undefined, groupId)
      },
      ...agentCreationItems(at, groupId),
      { label: 'New sticky note', icon: <IconNote />, onClick: () => addSticky(at, groupId) },
      { type: 'separator' },
      { type: 'colors', onPick: (c) => setNodesColor([groupId], c) },
      { type: 'separator' },
      ...(groupHasWorktree(groupId)
        ? []
        : [
            {
              label: 'Bind to worktree…',
              icon: <IconBranch />,
              onClick: () => bindGroupToWorktree(groupId)
            } as MenuItem
          ]),
      { label: 'Ungroup', icon: <IconUngroup />, onClick: () => ungroup(groupId) },
      { label: 'Delete (keeps nodes)', icon: <IconTrash />, danger: true, onClick: () => ungroup(groupId) }
    ],
    [
      setNodesColor,
      ungroup,
      groupHasWorktree,
      bindGroupToWorktree,
      addTerminal,
      agentCreationItems,
      addSticky
    ]
  )

  const onPaneContextMenu = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      e.preventDefault()
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          // Sessions: local terminal, agent CLIs, remote host.
          { label: 'New terminal', icon: <IconTerminal />, onClick: () => addTerminal(at) },
          ...agentCreationItems(at),
          {
            label: 'New remote…',
            icon: <IconTerminal />,
            onClick: () => openRemotePicker({ x: e.clientX, y: e.clientY })
          },
          { type: 'separator' },
          // Content nodes.
          { label: 'New browser', icon: <IconRemote />, onClick: () => addBrowser(at) },
          { label: 'New sticky note', icon: <IconNote />, onClick: () => addSticky(at) },
          { label: 'New dino game', icon: <IconDino />, onClick: () => addDino(at) },
          { label: 'Open file…', icon: <IconEditor />, onClick: () => void openFileDialog(at) },
          { type: 'separator' },
          // Canvas actions.
          { label: 'Select all', icon: <IconSelectAll />, onClick: selectAll },
          { label: 'Fit view', icon: <IconFit />, onClick: () => fitView({ padding: 0.2, duration: 300 }) }
        ]
      })
    },
    [
      screenToFlowPosition,
      addTerminal,
      agentCreationItems,
      addSticky,
      addDino,
      addBrowser,
      openFileDialog,
      openRemotePicker,
      selectAll,
      fitView
    ]
  )

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault()
      // For a group frame, remember WHERE inside it the user right-clicked so "New …" creation
      // entries can place the node at the cursor (parentInto converts to group-relative).
      const items =
        node.type === 'group'
          ? groupItems(node.id, screenToFlowPosition({ x: e.clientX, y: e.clientY }))
          : selectionItems(targetIds(node))
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [groupItems, selectionItems, targetIds, screenToFlowPosition]
  )

  const onSelectionContextMenu = useCallback(
    (e: React.MouseEvent, selected: Node[]) => {
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, items: selectionItems(selected.map((n) => n.id)) })
    },
    [selectionItems]
  )

  // Title/color/text edits go through updateNodeData; watch them so they persist too.
  // Signatures are cached per data-object reference: a drag/resize creates new node objects but
  // keeps each node's `data` ref, so drag frames do pointer lookups + compares only — the old
  // version rebuilt one string per node (plus a big join) on every frame of a drag.
  const dataSigCacheRef = useRef(new WeakMap<object, string>())
  const lastDataSigsRef = useRef<string[] | null>(null)
  useEffect(() => {
    const cache = dataSigCacheRef.current
    const sigs = new Array<string>(nodes.length)
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]
      let sig = cache.get(n.data)
      if (sig === undefined) {
        sig = `${n.id}:${n.data.title}:${n.data.color}:${n.data.text ?? ''}:${
          n.data.collapsed ? 1 : 0
        }:${((n.data.tags as string[]) ?? []).join(',')}`
        cache.set(n.data, sig)
      }
      sigs[i] = sig
    }
    const last = lastDataSigsRef.current
    lastDataSigsRef.current = sigs
    if (!last || last.length !== sigs.length) {
      markDirty() // mount/load runs are suppressed inside markDirty via loadingRef
      return
    }
    for (let i = 0; i < sigs.length; i++) {
      if (sigs[i] !== last[i]) {
        markDirty()
        return
      }
    }
  }, [nodes, markDirty])

  const zoomRafRef = useRef<number | null>(null)
  const onMove = useCallback(
    (_e: unknown, vp: Viewport) => {
      viewportRef.current = vp
      markDirty()
      // Coalesce the zoom-% readout to one update per frame so a zoom gesture doesn't
      // re-render the whole Canvas on every intermediate viewport event.
      if (zoomRafRef.current == null) {
        zoomRafRef.current = requestAnimationFrame(() => {
          zoomRafRef.current = null
          setZoomPct(Math.round(viewportRef.current.zoom * 100))
          setGroupLabelBoost(viewportRef.current.zoom)
        })
      }
    },
    [markDirty]
  )

  // ---- project (tab) actions ----
  const switchProject = useCallback(
    (id: string) => {
      if (id === useProjects.getState().activeProjectId) return
      commitActiveToStore()
      useProjects.getState().setActive(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  // Focus a node by id (notification click): select + center it; if it lives in another
  // project, switch there first and let the project-load effect finish the focus.
  const focusNodeById = useCallback(
    (nodeId: string) => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      if (node) {
        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })))
        goToNode(node)
        // Mark this node as the one being watched, so an agent still producing output does not
        // immediately re-flag it unread after we clear it (unread edges gate on activeId).
        useAgentStatus.getState().setActive(nodeId, true)
        useAgentStatus.getState().clearUnread(nodeId)
        return
      }
      const owner = useProjects
        .getState()
        .projects.find((p) => p.nodes.some((n) => n.id === nodeId))
      if (owner && owner.id !== useProjects.getState().activeProjectId) {
        pendingFocusRef.current = nodeId
        switchProject(owner.id)
      }
    },
    [setNodes, goToNode, switchProject]
  )

  const onPaletteQuery = useCallback((q: string) => {
    transcriptQueryRef.current = q
    // Reset any pending search so rapid keystrokes only fire one IPC call.
    if (transcriptSearchTimer.current) clearTimeout(transcriptSearchTimer.current)
    if (q.trim().length < 2) {
      setTranscriptHits([])
      return
    }
    const mine = q
    // Debounce the actual search by ~180ms.
    transcriptSearchTimer.current = setTimeout(() => {
      window.nodeTerminal.transcripts.search(q).then((hits) => {
        // Stale-response guard: ignore results for a query the user has moved past.
        if (transcriptQueryRef.current === mine) setTranscriptHits(hits)
      })
    }, 180)
  }, [])

  // Map a transcript hit's sessionId to a live node (via agentStatus). If that node still
  // exists anywhere, focus it; otherwise open a new Claude node that resumes the session.
  const openTranscriptHit = useCallback(
    (hit: TranscriptHit) => {
      const byId = useAgentStatus.getState().byId
      const projects = useProjects.getState().projects
      const boundNodeId = Object.entries(byId).find(
        ([nodeId, st]) =>
          st.sessionId === hit.sessionId &&
          (nodesRef.current.some((n) => n.id === nodeId) ||
            projects.some((p) => p.nodes.some((n) => n.id === nodeId)))
      )?.[0]
      if (boundNodeId) {
        focusNodeById(boundNodeId)
        return
      }
      // No live node — open a resume node in the active project, using the transcript's cwd.
      const cmd = resumeCommand('claude', hit.sessionId)
      if (!cmd) return
      const node = createAgentNode('claude', nodesRef.current.length, hit.cwd, viewCenter())
      node.data = { ...node.data, initialCommand: cmd }
      node.selected = true
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), node])
      markDirty()
      goToNode(node)
    },
    [focusNodeById, setNodes, markDirty, goToNode, viewCenter]
  )

  useEffect(() => window.nodeTerminal.onFocusNode(focusNodeById), [focusNodeById])

  // A browser guest's new-window (target=_blank / window.open) request → open another browser node
  // (never a real popup; main denies the real one) roped below/right of the source. Reads the
  // latest nodes via nodesRef so the deps stay []. Rope is display-only (controlEdges, not persisted).
  useEffect(() => {
    return window.nodeTerminal.browser.onBrowserNewWindow(({ url, sourceNodeId }) => {
      const src = nodesRef.current.find((n) => n.id === sourceNodeId)
      if (!src) return
      // Guard against a hostile/careless page flooding the canvas with real Chromium nodes
      // (ad loops, setInterval(window.open)). Prune old records, then dedup + rate-cap.
      const now = Date.now()
      const recent = browserPopupSpawnsRef.current.filter((r) => now - r.t < 10000)
      const isDup = recent.some((r) => r.url === url && r.source === sourceNodeId && now - r.t < 2000)
      if (isDup || recent.length >= 8) {
        browserPopupSpawnsRef.current = recent
        console.warn('[browser] popup spawn blocked (dedup/rate cap):', url)
        return
      }
      recent.push({ url, source: sourceNodeId, t: now })
      browserPopupSpawnsRef.current = recent
      const srcW = src.measured?.width ?? (src.width as number) ?? 800
      const srcH = src.measured?.height ?? (src.height as number) ?? 560
      // src.position is group-relative when the opener sits in a group frame: place in absolute
      // coords, then join the opener's group (parentInto converts back) so the popup node stays
      // inside the frame and moves with it.
      const srcGroup = src.parentId ? nodesRef.current.find((n) => n.id === src.parentId) : undefined
      const node = createBrowserNode(nodesRef.current.length, url, {
        x: src.position.x + (srcGroup?.position.x ?? 0) + srcW / 2 + 40,
        y: src.position.y + (srcGroup?.position.y ?? 0) + srcH + 80 + 280
      })
      const placed = src.parentId ? parentInto(node, src.parentId) : node
      setNodes((ns) => [...ns, placed])
      setControlEdges((es) => [...es, ropeEdge(`ctrl-${sourceNodeId}-${placed.id}`, sourceNodeId, placed.id, '#0a84ff')])
      markDirty()
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Apply canvas-control commands issued by a control-capable agent's `nodeterm` CLI. Reads the
  // LATEST nodes via nodesRef (so the effect deps stay []), validates the source as the real
  // authorization boundary, then applies the verb. Non-destructive verbs (list/open-*/show-*)
  // apply + reply immediately; destructive ones (write/close) go through the confirm dialog and
  // reply on BOTH confirm and cancel. Every path replies EXACTLY ONCE so the awaiting CLI call in
  // main never hangs to its 120s timeout.
  useEffect(() => {
    return window.nodeTerminal.onAgentControl(async ({ requestId, sourceNodeId, verb, args }) => {
      const reply = (r: { ok: boolean; message?: string; result?: unknown; error?: string }) =>
        window.nodeTerminal.sendAgentControlResult({ requestId, ...r })

      // Authorization boundary: the source must be a live, control-capable agent node.
      const src = nodesRef.current.find((n) => n.id === sourceNodeId)
      if (!src || !canControlCanvas((src.data.agentId as AgentId | undefined) ?? '')) {
        reply({ ok: false, error: 'source node is not a control-capable agent' })
        return
      }
      const srcTitle = (src.data.title as string) || sourceNodeId
      const srcCwd = src.data.cwd as string | undefined
      // Place opened nodes BELOW the source and rope them to it (source flow-out → target
      // flow-in), mirroring how subagent/loop nodes attach — so they read as "hanging off" the
      // conversation instead of landing on top of unrelated nodes. `placeBelow` returns a node
      // centerpoint; `i` fans multiple nodes out horizontally so they don't stack.
      const srcW = src.measured?.width ?? (src.width as number) ?? 600
      const srcH = src.measured?.height ?? (src.height as number) ?? 400
      // src.position is group-relative when the agent sits inside a group frame — resolve the
      // absolute position first so placements land below the agent regardless of grouping.
      const srcGroup = src.parentId ? nodesRef.current.find((n) => n.id === src.parentId) : undefined
      const srcAbs = {
        x: src.position.x + (srcGroup?.position.x ?? 0),
        y: src.position.y + (srcGroup?.position.y ?? 0)
      }
      const belowY = srcAbs.y + srcH + 80
      const edgeColor = agentConfig((src.data.agentId as string) ?? 'claude')?.color ?? '#d97757'
      const placeBelow = (i = 0) => ({ x: srcAbs.x + srcW / 2 + i * 460, y: belowY + 210 })
      const connect = (newId: string) =>
        setControlEdges((es) => [...es, ropeEdge(`ctrl-${sourceNodeId}-${newId}`, sourceNodeId, newId, edgeColor)])
      // Append a freshly-created node, draw its connecting edge, and mark the canvas dirty so it
      // persists. Returns the new node id. A node opened by a grouped agent joins that group
      // (parentInto converts back to group-relative coords), so the control fan-out stays inside
      // the frame and moves with it.
      const addAndConnect = (node: CanvasNode) => {
        const placed = src.parentId ? parentInto(node, src.parentId) : node
        setNodes((ns) => [...ns, placed])
        connect(placed.id)
        markDirty()
        return placed.id
      }

      try {
        switch (verb) {
          case 'list': {
            const list = nodesRef.current.map((n) => ({
              id: n.id,
              kind: n.type,
              title: n.data.title as string
            }))
            reply({
              ok: true,
              result: list,
              message: list.map((n) => `${n.id} [${n.kind}] ${n.title}`).join('\n')
            })
            return
          }
          case 'open-terminal': {
            const id = addAndConnect(
              createTerminalNode(nodesRef.current.length, args.cwd || srcCwd, placeBelow(), args.cmd)
            )
            reply({ ok: true, message: `opened terminal ${id}`, result: { id } })
            return
          }
          case 'open-claude':
          case 'open-agent': {
            // open-claude is the legacy fixed-agent form; open-agent takes any builtin
            // (claude/codex/gemini) or custom agent id — resolveAgent falls back for the rest.
            const agentId = (verb === 'open-agent' ? args.agent : 'claude') as AgentId
            const count = Math.max(1, Math.min(5, parseInt(args.count || '1', 10) || 1))
            // Inherit the source node's managed account, else the project default, else system —
            // the same funnel as addAgentNode (the factory drops accounts on non-claude agents).
            const projStore = useProjects.getState()
            const account = resolveNewNodeAccount(
              src.data.accountId as string | undefined,
              projStore.getProject(projStore.activeProjectId ?? ''),
              useSettings.getState().settings.claudeAccounts
            )
            const ids: string[] = []
            for (let i = 0; i < count; i++) {
              ids.push(
                addAndConnect(
                  createAgentNode(
                    agentId,
                    nodesRef.current.length + i,
                    args.cwd || srcCwd,
                    placeBelow(i),
                    args.prompt,
                    undefined,
                    account
                  )
                )
              )
            }
            reply({
              ok: true,
              message: `opened ${count} ${agentId} session(s): ${ids.join(', ')}`,
              result: { ids }
            })
            return
          }
          case 'show-image': {
            if (!args.path) {
              reply({ ok: false, error: 'show-image requires --path' })
              return
            }
            // EditorNode renders images via fs:read-binary → base64 data URL (not nt-media://),
            // so no media allowlist entry is needed here.
            const id = addAndConnect(createEditorNode(nodesRef.current.length, args.path, placeBelow()))
            reply({ ok: true, message: `showing image ${id}`, result: { id } })
            return
          }
          case 'show-video': {
            if (!args.path) {
              reply({ ok: false, error: 'show-video requires --path' })
              return
            }
            await window.nodeTerminal.media.allow(args.path)
            const id = addAndConnect(createVideoNode(nodesRef.current.length, args.path, placeBelow()))
            reply({ ok: true, message: `showing video ${id}`, result: { id } })
            return
          }
          case 'show-web': {
            let webSrc: { url?: string; filePath?: string }
            if (args.url) webSrc = { url: args.url }
            else if (args.file) webSrc = { filePath: args.file }
            else if (args.html) {
              // Raw HTML the agent wrote → persist via main, then load the file in the webview.
              const p = await window.nodeTerminal.media.writeHtml(args.html)
              webSrc = { filePath: p }
            } else {
              reply({ ok: false, error: 'show-web requires --url, --file or --html' })
              return
            }
            // For an agent-provided --file (not html we just wrote), allowlist it first.
            if (webSrc.filePath && args.file) await window.nodeTerminal.media.allow(webSrc.filePath)
            const id = addAndConnect(createWebNode(nodesRef.current.length, webSrc, placeBelow()))
            reply({ ok: true, message: `showing web ${id}`, result: { id } })
            return
          }
          case 'open-browser': {
            if (!args.url) {
              reply({ ok: false, error: 'open-browser requires --url' })
              return
            }
            const browserUrl = normalizeAddress(args.url)
            if (!browserUrl) {
              reply({ ok: false, error: 'open-browser requires a valid http(s) --url' })
              return
            }
            const id = addAndConnect(createBrowserNode(nodesRef.current.length, browserUrl, placeBelow()))
            reply({ ok: true, message: `opened browser ${id}`, result: { id } })
            return
          }
          case 'group': {
            const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const live = nodesRef.current as CanvasNode[]
            const resolvable = ids.filter((gid) => live.some((nd) => nd.id === gid && !nd.parentId && nd.type !== 'group'))
            if (resolvable.length === 0) {
              reply({ ok: false, error: 'group: none of the given node ids are groupable (top-level, non-group)' })
              return
            }
            const groupCount = live.filter((nd) => nd.type === 'group').length
            let grouped = groupSelectedNodes(live, resolvable, groupCount)
            const groupNode = grouped[0] // groupSelectedNodes returns the new group first
            if (args.label) {
              grouped = grouped.map((nd) =>
                nd.id === groupNode.id ? { ...nd, data: { ...nd.data, title: args.label } } : nd
              )
            }
            setNodes(grouped)
            markDirty()
            reply({ ok: true, message: `grouped ${resolvable.length} node(s) into ${groupNode.id}`, result: { groupId: groupNode.id } })
            return
          }
          case 'arrange': {
            const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const live = nodesRef.current as CanvasNode[]
            const layout = (['grid', 'row', 'column'] as const).find((l) => l === args.layout) ?? 'grid'
            const cols = args.cols ? parseInt(args.cols, 10) || undefined : undefined
            const next = arrangeNodes(live, ids, { layout, cols })
            if (next === live) {
              reply({ ok: false, error: 'arrange: none of the given node ids are top-level nodes' })
              return
            }
            setNodes(next)
            markDirty()
            reply({ ok: true, message: `arranged ${ids.length} node(s) as ${layout}`, result: { count: ids.length } })
            return
          }
          case 'align': {
            const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
            const edge = (['left', 'right', 'top', 'bottom', 'hcenter', 'vcenter'] as const).find((e2) => e2 === args.edge)
            if (!edge) {
              reply({ ok: false, error: 'align requires --edge left|right|top|bottom|hcenter|vcenter' })
              return
            }
            const live = nodesRef.current as CanvasNode[]
            const next = alignNodes(live, ids, edge)
            if (next === live) {
              reply({ ok: false, error: 'align: none of the given node ids are top-level nodes' })
              return
            }
            setNodes(next)
            markDirty()
            reply({ ok: true, message: `aligned ${ids.length} node(s) to ${edge}`, result: { count: ids.length } })
            return
          }
          case 'spawn-team': {
            let roles: { title?: string; prompt?: string; agent?: string }[]
            try {
              const parsed = JSON.parse(args.team ?? '')
              roles = Array.isArray(parsed) ? parsed : []
            } catch {
              reply({ ok: false, error: 'spawn-team: --team must be a JSON array of {title?, prompt, agent?}' })
              return
            }
            roles = roles.filter((r) => r && typeof r.prompt === 'string' && r.prompt.trim()).slice(0, 8)
            if (roles.length === 0) {
              reply({ ok: false, error: 'spawn-team: --team needs at least one role with a prompt' })
              return
            }
            const live = nodesRef.current as CanvasNode[]
            // Same account funnel as open-claude/open-agent above; per-role the factory
            // drops the account for non-claude agents.
            const teamStore = useProjects.getState()
            const teamAccount = resolveNewNodeAccount(
              src.data.accountId as string | undefined,
              teamStore.getProject(teamStore.activeProjectId ?? ''),
              useSettings.getState().settings.claudeAccounts
            )
            // Build members; fixed role titles pin the node name (titleAuto off).
            const members = roles.map((r, i) => {
              const node = createAgentNode(
                r.agent ?? 'claude',
                live.length + i,
                srcCwd,
                placeBelow(i),
                r.prompt,
                undefined,
                teamAccount
              )
              return r.title ? { ...node, data: { ...node.data, title: r.title, titleAuto: false } } : node
            })
            const memberIds = members.map((m) => m.id)
            // One computed array: append → arrange in a grid below the conductor → wrap in a group.
            let next: CanvasNode[] = [...live, ...members]
            next = arrangeNodes(next, memberIds, { layout: 'grid', origin: placeBelow(0) })
            const groupCount = next.filter((nd) => nd.type === 'group').length
            next = groupSelectedNodes(next, memberIds, groupCount)
            const teamGroup = next[0]
            next = next.map((nd) =>
              nd.id === teamGroup.id ? { ...nd, data: { ...nd.data, title: args.label || 'Team' } } : nd
            )
            setNodes(next)
            memberIds.forEach((mid) => connect(mid))
            markDirty()
            reply({
              ok: true,
              message: `spawned ${memberIds.length} member(s) in group ${teamGroup.id}: ${memberIds.join(', ')}`,
              result: { groupId: teamGroup.id, memberIds }
            })
            return
          }
          case 'branch': {
            const id = args.node ?? ''
            const target = nodesRef.current.find((nd) => nd.id === id)
            if (!target) {
              reply({ ok: false, error: `branch: no node with id ${id}` })
              return
            }
            const targetAgent = target.data.agentId as AgentId | undefined
            if (!targetAgent || !canBranch(targetAgent)) {
              reply({ ok: false, error: 'branch: node is not a branch-capable agent node' })
              return
            }
            const res = await branchClaude(id, { interactive: false })
            reply(
              res.ok
                ? { ok: true, message: `branched ${id}; original resumes in ${res.newNodeId}`, result: { newNodeId: res.newNodeId } }
                : { ok: false, error: res.error }
            )
            return
          }
          case 'rename': {
            const id = args.node ?? ''
            const title = (args.title ?? '').trim()
            const target = nodesRef.current.find((nd) => nd.id === id)
            if (!target) {
              reply({ ok: false, error: `rename: no node with id ${id}` })
              return
            }
            // Same semantics as renameSession: an explicit rename takes ownership of the
            // name (titleAuto off) and mirrors it into a rename-capable agent's session.
            setNodes((ns) =>
              ns.map((nd) => (nd.id === id ? { ...nd, data: { ...nd.data, title, titleAuto: false } } : nd))
            )
            markDirty()
            const agentId = target.data.agentId as AgentId | undefined
            if (agentId && canRename(agentId)) {
              void window.nodeTerminal.pty.sendText(id, `/rename ${title}`)
            }
            reply({ ok: true, message: `renamed ${id} to "${title}"` })
            return
          }
          case 'write': {
            if (!args.node) {
              reply({ ok: false, error: 'write requires --node' })
              return
            }
            // One confirm dialog at a time: setConfirm would replace a pending one, orphaning its
            // reply and hanging that earlier request to its 120s timeout. Reject instead.
            if (confirmRef.current) {
              reply({ ok: false, error: 'a confirmation is already pending — try again' })
              return
            }
            // Destructive → confirm. Replies on confirm AND cancel.
            setConfirm({
              message: `Agent "${srcTitle}" wants to send to ${args.node}:\n\n${args.text ?? ''}`,
              confirmLabel: 'Send',
              onConfirm: async () => {
                setConfirm(null)
                try {
                  const ok = await window.nodeTerminal.pty.sendText(args.node, args.text ?? '')
                  reply({
                    ok,
                    message: ok ? 'sent' : 'failed',
                    error: ok ? undefined : 'sendText failed'
                  })
                } catch (e) {
                  reply({ ok: false, error: String(e) })
                }
              },
              onCancel: () => reply({ ok: false, error: 'denied by user' })
            })
            return
          }
          case 'close': {
            if (!args.node) {
              reply({ ok: false, error: 'close requires --node' })
              return
            }
            // One confirm dialog at a time (see `write`): reject rather than orphan a pending one.
            if (confirmRef.current) {
              reply({ ok: false, error: 'a confirmation is already pending — try again' })
              return
            }
            // Destructive → confirm. Replies on confirm AND cancel.
            setConfirm({
              message: `Agent "${srcTitle}" wants to close node ${args.node}. Close it?`,
              confirmLabel: 'Close',
              danger: true,
              onConfirm: () => {
                setConfirm(null)
                // Canonical teardown: deleteNodes() destroys the local tmux session (remote-guarded),
                // drops persisted agentStatus, and reparents any group children. Don't hand-roll it.
                deleteNodes([args.node])
                setControlEdges((es) =>
                  es.filter((e) => e.source !== args.node && e.target !== args.node)
                )
                reply({ ok: true, message: `closed ${args.node}` })
              },
              onCancel: () => reply({ ok: false, error: 'denied by user' })
            })
            return
          }
          default:
            reply({ ok: false, error: `unknown verb: ${verb}` })
        }
      } catch (e) {
        reply({ ok: false, error: String(e) })
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- sessions sidebar actions ----
  // Close (end) a session. tmux sessions are keyed by node id, so destroy works for an
  // inactive project's node even though it isn't mounted; then drop it from the store.
  const closeSession = useCallback(
    (projectId: string, id: string) => {
      setConfirm({
        message: 'End this session? This stops its tmux session.',
        confirmLabel: 'End session',
        danger: true,
        onConfirm: () => {
          if (projectId === activeProjectId) {
            deleteNodes([id])
          } else {
            disposeTerminalOnUnmount(id) // node may be parked from the project switch
            transport.destroy(id)
            // Chat nodes in an inactive project keep their driver running across the switch;
            // dispose is a no-op for non-chat ids, so call it unconditionally like destroy.
            window.nodeTerminal.chat.dispose(id)
            useChatSessions.getState().drop(id)
            useAgentStatus.getState().remove(id)
            useProjects.getState().removeNode(projectId, id)
            void writeDisk()
          }
          setConfirm(null)
        }
      })
    },
    [activeProjectId, deleteNodes, writeDisk]
  )

  const renameSession = useCallback(
    (projectId: string, id: string, title: string) => {
      if (projectId === activeProjectId) {
        // An explicit rename takes ownership of the name → stop auto-tracking the session.
        setNodes((ns) =>
          ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, title, titleAuto: false } } : n))
        )
        markDirty()
      } else {
        useProjects.getState().renameNode(projectId, id, title)
        void writeDisk()
      }
      // Mirror the new name into a rename-capable agent's live session (tmux send-keys works
      // whether or not the node is currently mounted). Same one-way push as the node header's ✦.
      const liveAgent = nodesRef.current.find((n) => n.id === id)?.data.agentId as AgentId | undefined
      const storedAgent = useProjects
        .getState()
        .projects.find((p) => p.id === projectId)
        ?.nodes.find((n) => n.id === id)?.agentId
      const agentId = liveAgent ?? storedAgent
      const name = title.trim()
      if (agentId && canRename(agentId) && name) {
        void window.nodeTerminal.pty.sendText(id, `/rename ${name}`)
      }
    },
    [activeProjectId, setNodes, markDirty, writeDisk]
  )

  // Sidebar "Name with AI": generate a title from the session's captured terminal output
  // (same BYO-agent path as the terminal node's ✦), then apply it via renameSession.
  const aiNameSession = useCallback(
    async (projectId: string, id: string, cwd?: string) => {
      // Track progress in a store keyed by node id so the spinner survives the row/sidebar
      // unmounting mid-request; this Canvas-level call completes and applies the name anyway.
      useSessionNaming.getState().set(id, true)
      try {
        const r = await window.nodeTerminal.pty.generateName(id, cwd ?? '')
        if (r.ok) renameSession(projectId, id, r.message)
      } finally {
        useSessionNaming.getState().set(id, false)
      }
    },
    [renameSession]
  )

  // Sidebar "Name with AI" for a canvas group: generate a title from its member terminals'
  // captured output, then apply it to the group node (renameSession renames any node by id).
  const aiNameGroup = useCallback(
    async (projectId: string, groupId: string, memberIds: string[], cwd?: string) => {
      if (memberIds.length === 0) return
      useSessionNaming.getState().set(groupId, true)
      try {
        const r = await window.nodeTerminal.pty.generateGroupName(memberIds, cwd ?? '')
        if (r.ok) renameSession(projectId, groupId, r.message)
      } finally {
        useSessionNaming.getState().set(groupId, false)
      }
    },
    [renameSession]
  )

  const addToProject = useCallback(
    (projectId: string) => {
      if (projectId === activeProjectId) {
        addTerminal()
      } else {
        // Add once the project's nodes have loaded into React Flow (load effect consumes this).
        pendingAddRef.current = projectId
        switchProject(projectId)
      }
    },
    [activeProjectId, addTerminal, switchProject]
  )

  // Sidebar drag-to-group: reparent a session into a canvas group (groupId) or out (null).
  const moveSessionToGroup = useCallback(
    (projectId: string, nodeId: string, groupId: string | null) => {
      if (projectId === activeProjectId) {
        setNodes((ns) => reparentNode(ns, nodeId, groupId))
        markDirty()
      } else {
        useProjects.getState().moveNodeToGroup(projectId, nodeId, groupId)
        void writeDisk()
      }
    },
    [activeProjectId, setNodes, markDirty, writeDisk]
  )

  // Sidebar reorder: place draggedId immediately before beforeId (sidebar order = node order),
  // joining the target's container if they differ.
  const reorderSession = useCallback(
    (projectId: string, draggedId: string, beforeId: string) => {
      if (projectId === activeProjectId) {
        setNodes((ns) => reorderNodeBefore(ns, draggedId, beforeId))
        markDirty()
      } else {
        useProjects.getState().reorderNode(projectId, draggedId, beforeId)
        void writeDisk()
      }
    },
    [activeProjectId, setNodes, markDirty, writeDisk]
  )

  const onRowContextMenu = useCallback(
    (e: React.MouseEvent, projectId: string, id: string) => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: 'Go to', icon: <IconJump />, onClick: () => focusNodeById(id) },
          {
            label: 'Rename',
            icon: <IconEditor />,
            onClick: () => {
              void promptDialog({ message: 'Rename session' }).then((t) => {
                if (t && t.trim()) renameSession(projectId, id, t.trim())
              })
            }
          },
          {
            label: 'Duplicate',
            icon: <IconDuplicate />,
            onClick: () => {
              if (projectId === activeProjectId) duplicateNodes([id])
              else {
                useProjects.getState().duplicateNode(projectId, id)
                void writeDisk()
              }
            }
          },
          {
            label: 'Close',
            icon: <IconTrash />,
            danger: true,
            onClick: () => closeSession(projectId, id)
          }
        ]
      })
    },
    [activeProjectId, focusNodeById, renameSession, duplicateNodes, closeSession, writeDisk]
  )

  // Stream live subagent transcript chunks into the agent-nodes store.
  useEffect(
    () =>
      window.nodeTerminal.onSubagentActivity((e) =>
        useAgentNodes.getState().appendActivity(e.toolUseId, e.chunk)
      ),
    []
  )

  // Agent lifecycle, reported by each agent's own hooks via the main-process hook server
  // (`main/agents/hook-server.ts`) and mapped to the shared 4-state model by the per-agent
  // normalizers (`shared/agents/normalize.ts`): working / waiting / blocked / done. On a turn
  // finishing / needing attention while the window is in the background: mark unread +
  // (with consent, throttled) notify.
  const notifyCooldownRef = useRef<Record<string, number>>({})
  useEffect(() => {
    // Notification context = the node's folder name (or its title).
    const contextFor = (nodeId: string): string => {
      const node = nodesRef.current.find((n) => n.id === nodeId)
      const cwd = (node?.data.cwd as string) || ''
      const folder = cwd.replace(/\/+$/, '').split('/').filter(Boolean).pop()
      const title = node?.data.title as string | undefined
      return folder || (title && title !== 'Claude Code' ? title : '') || 'workspace'
    }
    const clip = (s: string | undefined, max = 180): string => {
      const t = (s ?? '').replace(/\s+/g, ' ').trim()
      return t.length <= max ? t : `${t.slice(0, max - 1)}…`
    }
    return window.nodeTerminal.onAgentStatus((e: NormalizedAgentEvent) => {
      const cs = useAgentStatus.getState()
      if (e.sessionId) cs.setSessionId(e.nodeId, e.sessionId)
      const agentLabel = agentConfig(e.agentId)?.label ?? 'Agent'
      // "<folder> — Claude finished" + last assistant message as the body.
      const alert = (statusText: string, fallbackBody: string) => {
        // Unread unless the user is actively in this node's terminal (focused window +
        // this node is the active terminal). So a finish while you're in another terminal,
        // or with nothing focused, still flags unread.
        const watching = document.hasFocus() && cs.activeId === e.nodeId
        if (!watching) cs.markUnread(e.nodeId)
        // OS notification only when the whole window is in the background.
        if (document.hasFocus()) return
        const s = useSettings.getState().settings
        if (!(s.notifyOnClaudeDone && s.notifyConsentAsked)) return
        const now = Date.now()
        if (now - (notifyCooldownRef.current[e.nodeId] ?? 0) < 5000) return // dedup/cooldown
        notifyCooldownRef.current[e.nodeId] = now
        void window.nodeTerminal.notify({
          title: `${contextFor(e.nodeId)} — ${agentLabel} ${statusText}`,
          body: clip(e.lastMessage) || fallbackBody,
          nodeId: e.nodeId
        })
      }
      const an = useAgentNodes.getState()
      switch (e.kind) {
        case 'state':
          if (e.state) cs.setState(e.nodeId, e.state, e.agentId, e.newTurn)
          if (e.newTurn) an.clearForParent(e.nodeId) // genuine new turn → drop the previous fan-out
          if (e.newTurn && e.task) {
            // Prompt-prefix fallback for /loop|/schedule|/cron when the natural-language
            // phrasing doesn't trigger the tool-based (recurring) detection.
            const m = e.task.match(/^\s*\/(loop|schedule|cron)\b/)
            if (m) cs.setLoop(e.nodeId, true, m[1] as 'loop' | 'schedule' | 'cron', { task: e.task })
          }
          if (e.state === 'done' && !e.interrupted) {
            // Interrupted turns (Esc/Ctrl-C) alert nobody: the user did it themselves, and
            // the turn didn't complete, so it isn't a loop iteration either.
            cs.bumpLoop(e.nodeId, e.lastMessage) // count loop iterations + summary (no-op if not looping)
            alert('finished', `${agentLabel} finished its turn.`)
          }
          if (e.state === 'blocked') alert('needs input', `${agentLabel} needs permission to continue.`)
          else if (e.state === 'waiting') alert('needs input', `${agentLabel} is waiting for your response.`)
          break
        case 'subagent-start':
          if (e.toolUseId) {
            an.start(e.toolUseId, {
              parentNodeId: e.nodeId,
              type: e.subagentType,
              label: e.taskLabel
            })
          }
          break
        case 'subagent-end':
          if (e.toolUseId)
            an.finish(e.toolUseId, {
              durationMs: e.durationMs,
              tokens: e.tokens,
              toolUses: e.toolUses,
              result: e.result
            })
          break
        case 'recurring':
          if (e.recurringEnd) {
            // The recurring job itself was removed (CronDelete) — take the card down.
            cs.setLoop(e.nodeId, false)
            an.clearLoop(e.nodeId)
          } else if (e.recurringKind) {
            cs.setLoop(e.nodeId, true, e.recurringKind, { schedule: e.schedule, task: e.task })
          }
          break
        case 'session':
          if (e.sessionTitle) cs.setSession(e.nodeId, e.sessionTitle)
          if (e.sessionPhase === 'start') cs.setState(e.nodeId, undefined, e.agentId)
          if (e.sessionPhase === 'end') {
            cs.setState(e.nodeId, undefined, e.agentId)
            // In-session /loop dies with its session; cron (and scheduled cloud routines)
            // keep running after it — their cards stay until CronDelete / manual dismiss.
            const kind = cs.byId[e.nodeId]?.loop?.kind
            if (kind === 'loop') {
              cs.setLoop(e.nodeId, false)
              an.clearLoop(e.nodeId)
            }
            an.clearForParent(e.nodeId)
          }
          break
      }
    })
  }, [])

  // Safety net for a lost Stop POST / crashed CLI: decay working entries that saw no hook
  // event at all for STALE_WORKING_MS (the sweep itself is cheap; see agentStatus.ts).
  useEffect(() => {
    const t = setInterval(() => useAgentStatus.getState().sweepStaleWorking(), 60_000)
    return () => clearInterval(t)
  }, [])

  // When the palette opens, capture each terminal's visible buffer (cached ~3s) so the
  // search can match text shown in terminals/Claude sessions.
  useEffect(() => {
    if (!paletteOpen) return
    const now = Date.now()
    const stale = nodesRef.current.filter(
      (n) => n.type === 'terminal' && now - (captureTsRef.current[n.id] ?? 0) > 3000
    )
    if (!stale.length) return
    let cancelled = false
    void Promise.all(
      stale.map(async (n) => [n.id, await window.nodeTerminal.pty.capture(n.id)] as const)
    ).then((pairs) => {
      if (cancelled) return
      const ts = Date.now()
      setBufferCache((prev) => {
        const next = { ...prev }
        for (const [id, text] of pairs) {
          next[id] = text
          captureTsRef.current[id] = ts
        }
        return next
      })
    })
    return () => {
      cancelled = true
    }
  }, [paletteOpen])

  // First-launch consent: ask once whether to enable Claude completion notifications.
  // Gated on settings hydration — otherwise it runs before settings load from disk and
  // sees the default (notifyConsentAsked=false) on every launch, re-asking each time.
  const settingsHydrated = useSettings((s) => s.hydrated)
  useEffect(() => {
    if (!settingsHydrated) return
    if (useSettings.getState().settings.notifyConsentAsked) return
    useSettings.getState().update({ notifyConsentAsked: true, notifyOnClaudeDone: false })
    setConsentOpen(true)
  }, [settingsHydrated])

  // Load saved SSH servers once so the RemotePicker / palette have them available.
  useEffect(() => {
    void useSshServers.getState().hydrate()
  }, [])

  // Track SSH project connection status for the thin connection banner (keyed by project id).
  useEffect(() => {
    return window.nodeTerminal.sshProject.onStatus((e) =>
      setSshStatus((prev) => ({ ...prev, [e.projectId]: e.status }))
    )
  }, [])

  // Create an SSH project from the dialog: commit the current canvas, add + switch to the new
  // project (its master is opened by the active-project effect on switch), persist.
  const createSshProject = useCallback(
    (input: { server: SshServer; remoteCwd: string; label: string }) => {
      commitActiveToStore()
      const project = useProjects
        .getState()
        .addProject(input.label, undefined, { server: input.server, remoteCwd: input.remoteCwd })
      useProjects.getState().setActive(project.id)
      // Same contract as onRepoCloned: the welcome screen waits behind the SSH dialog and
      // dismisses only once the project is created (cancel returns to the welcome screen).
      setWelcomeOpen(false)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  const addProject = useCallback(() => {
    commitActiveToStore()
    const project = useProjects.getState().addProject()
    useProjects.getState().setActive(project.id)
    void writeDisk()
  }, [commitActiveToStore, writeDisk])

  /** Returns true when a folder was picked (false on cancel), so callers like the welcome
   *  screen can keep their overlay up until the picker actually resolves. */
  const addProjectFromFolder = useCallback(async (): Promise<boolean> => {
    const folder = await window.nodeTerminal.dialog.selectFolder()
    if (!folder) return false
    commitActiveToStore()
    // A folder maps to one project: reuse (and reopen, if closed) the existing one, or create.
    useProjects.getState().openFolderProject(folder)
    void writeDisk()
    return true
  }, [commitActiveToStore, writeDisk])

  const renameProject = useCallback(
    (id: string, name: string) => {
      useProjects.getState().renameProject(id, name)
      void persist()
    },
    [persist]
  )

  const setProjectFolder = useCallback(
    async (id: string) => {
      const folder = await window.nodeTerminal.dialog.selectFolder()
      if (!folder) return
      useProjects.getState().setProjectCwd(id, folder)
      void persist()
    },
    [persist]
  )

  const setProjectDefaultAccount = useCallback(
    (id: string, accountId: string | undefined) => {
      useProjects.getState().setProjectDefaultAccount(id, accountId)
      void persist()
    },
    [persist]
  )

  // Close a project: hide it from the tab bar but keep it (and its tmux/agent sessions) intact
  // so it can be reopened later from the start screen. Non-destructive — the inverse of the old
  // "Delete project". Switching away unmounts its nodes (a detach, not a kill); the sessions
  // survive exactly like a project switch, and a cold restart later reconstructs them.
  const closeProject = useCallback(
    (id: string) => {
      const store = useProjects.getState()
      if (id === store.activeProjectId) commitActiveToStore()
      store.closeProject(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  // Right-click on a sidebar project header: the same project actions as the tab caret menu,
  // in the shared ContextMenu shell.
  const onProjectContextMenu = useCallback(
    (e: React.MouseEvent, projectId: string) => {
      e.preventDefault()
      e.stopPropagation()
      const project = useProjects.getState().projects.find((p) => p.id === projectId)
      if (!project) return
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: 'Go to project',
            icon: <IconSwitch />,
            disabled: projectId === activeProjectId,
            onClick: () => switchProject(projectId)
          },
          {
            label: 'Rename',
            icon: <IconEditor />,
            onClick: () => {
              void promptDialog({ message: 'Rename project', initialValue: project.name }).then((t) => {
                if (t && t.trim()) renameProject(projectId, t.trim())
              })
            }
          },
          { label: 'Set folder…', icon: <IconProject />, onClick: () => setProjectFolder(projectId) },
          { type: 'separator' },
          {
            label: 'Close project',
            icon: <IconTrash />,
            danger: true,
            onClick: () => closeProject(projectId)
          }
        ]
      })
    },
    [activeProjectId, switchProject, renameProject, setProjectFolder, closeProject]
  )

  // Reopen a previously closed project and make it active — the active-project effect reloads its
  // serialized nodes, whose TerminalNodes reattach to the surviving tmux sessions (or cold-restore).
  const reopenProject = useCallback(
    (id: string) => {
      commitActiveToStore()
      useProjects.getState().reopenProject(id)
      setWelcomeOpen(false)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  // Permanently remove a project (from the "Recently closed" list): end every terminal's tmux
  // session, drop persisted agent status, tear down any SSH master, then delete it from disk.
  const deleteProject = useCallback(
    (id: string) => {
      const store = useProjects.getState()
      if (id === store.activeProjectId) commitActiveToStore()
      // End the tmux sessions of every terminal in the deleted project, and drop their
      // persisted agent status (node unmount no longer removes it).
      const project = store.getProject(id)
      project?.nodes.forEach((n) => {
        if ((n.kind ?? 'terminal') === 'terminal') {
          disposeTerminalOnUnmount(n.id) // may be parked from a recent switch away
          transport.destroy(n.id)
        }
        if ((n.kind ?? 'terminal') === 'chat') {
          window.nodeTerminal.chat.dispose(n.id)
          useChatSessions.getState().drop(n.id)
        }
        useAgentStatus.getState().remove(n.id)
      })
      // SSH project: the per-node `transport.destroy` above only ends the REMOTE session for
      // the (mounted) ACTIVE project's nodes — a non-active project has no live local sessions,
      // so its remote `nt-<id>` sessions would leak. Drive the remote teardown authoritatively
      // from main, keyed on the project binding, and sequence it BEFORE disconnect (which kills
      // the master): kill every terminal node's remote session over the still-alive master, then
      // tear the master down. Drop the cached controlPath immediately.
      if (project?.ssh) {
        const nodeIds = project.nodes
          .filter((n) => (n.kind ?? 'terminal') === 'terminal')
          .map((n) => n.id)
        void window.nodeTerminal.sshProject
          .killSessions(id, nodeIds)
          .catch(() => {})
          .finally(() => void window.nodeTerminal.sshProject.disconnect(id))
        useSshConn.getState().clear(id)
      }
      store.deleteProject(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  const now = useMemo(() => Date.now(), [transcriptHits])
  const transcriptCommands = useMemo<Command[]>(
    () =>
      transcriptHits.map((hit) => ({
        id: `transcript:${hit.sessionId}`,
        label: hit.title || hit.sessionId,
        hint: [hit.projectLabel, relativeTime(hit.mtime, now)].filter(Boolean).join(' · '),
        section: 'Conversations',
        icon: <AgentIcon agentId="claude" />,
        run: () => openTranscriptHit(hit)
      })),
    [transcriptHits, openTranscriptHit, now]
  )

  const buildCommands = useCallback((): Command[] => {
    const disabled = useSettings.getState().settings.disabledAgents
    const cmds: Command[] = [
      { id: 'new-term', label: 'New terminal', section: 'Create', icon: <IconTerminal />, run: () => addTerminal() },
      ...BUILTIN_AGENT_IDS.filter((aid) => !disabled.includes(aid)).map(
        (aid): Command => ({
          id: `new-${aid}`,
          label: `New ${AGENT_CONFIG[aid].label}`,
          icon: <AgentIcon agentId={aid} />,
          run: () => addAgentNode(aid)
        })
      ),
      ...useSettings
        .getState()
        .settings.customAgents.filter((c) => !disabled.includes(c.id))
        .map(
          (c): Command => ({
            id: `new-${c.id}`,
            label: `New ${c.label}`,
            icon: <AgentIcon agentId={c.id} />,
            run: () => addAgentNode(c.id)
          })
        ),
      // One "New Claude — <label>" per account usable in the active project (local accounts for a
      // local project, this host's accounts for an SSH project). Plain "New Claude" above uses the
      // resolved project default; these pin a specific account.
      ...accountsForProject(
        useSettings.getState().settings.claudeAccounts,
        useProjects.getState().getProject(activeProjectId)
      )
        .map(
          (a): Command => ({
            id: `new-claude-${a.id}`,
            label: `New Claude — ${a.label}`,
            icon: <AgentIcon agentId="claude" />,
            run: () => addAgentNode('claude', undefined, undefined, a.id)
          })
        ),
      { id: 'new-chat', label: 'New chat', icon: <IconChat />, run: () => addChatNode() },
      { id: 'new-sticky', label: 'New sticky note', icon: <IconNote />, run: () => addSticky() },
      { id: 'new-dino', label: 'New dino game', icon: <IconDino />, run: () => addDino() },
      { id: 'open-file', label: 'Open file…', icon: <IconEditor />, run: () => void openFileDialog() },
      { id: 'open-web', label: 'Open web view…', icon: <IconRemote />, run: () => addWebView() },
      { id: 'open-browser', label: 'New browser', icon: <IconRemote />, run: () => addBrowser() },
      ...useSshServers.getState().servers.map(
        (srv): Command => ({
          id: `new-remote-${srv.id}`,
          label: `New remote: ${srv.label}`,
          icon: <IconTerminal />,
          run: () =>
            requireProOr('Remote SSH terminals', () =>
              addSshTerminal(srv, { x: window.innerWidth / 2, y: window.innerHeight / 2 })
            )
        })
      ),
      { id: 'new-project', label: 'New project', icon: <IconProject />, run: () => addProject() },
      { id: 'clone-repo', label: 'Clone repository…', icon: <IconProject />, run: () => setCloneDialogOpen(true) },
      {
        id: 'new-remote',
        label: 'New Remote Connection',
        icon: <IconRemote />,
        run: () => void connectRemote()
      },
      { id: 'fit', label: 'Fit view', icon: <IconFit />, run: () => fitView({ padding: 0.2, duration: 300 }) },
      { id: 'save', label: 'Save', icon: <IconSave />, run: () => void persist() }
    ]
    const store = useProjects.getState()
    store.projects
      .filter((p) => p.id !== store.activeProjectId)
      .forEach((p) =>
        cmds.push({
          id: `proj-${p.id}`,
          label: `Switch to ${p.name}`,
          hint: 'project',
          icon: <IconSwitch />,
          run: () => switchProject(p.id)
        })
      )
    const cs = useAgentStatus.getState()
    nodesRef.current
      .filter((n) => n.type !== 'group')
      .forEach((n) => {
        const tags = (n.data.tags as string[]) ?? []
        const a =
          (n.data.agentId as AgentId | undefined) ?? (tags.includes('claude') ? 'claude' : undefined)
        const isAgent = !!a && hasHooks(a)
        const session = isAgent ? cs.byId[n.id]?.session : undefined
        // Show the running agent's icon (claude/codex/gemini/custom) when the node is an agent,
        // otherwise an icon matching the node kind — mirrors the right-click/add-node actions.
        const icon = a ? (
          <AgentIcon agentId={a} />
        ) : n.type === 'editor' ? (
          <IconEditor />
        ) : n.type === 'sticky' ? (
          <IconNote />
        ) : (
          <IconTerminal />
        )
        cmds.push({
          id: `node-${n.id}`,
          label: `Go to ${n.data.title}`,
          section: 'Opened terminals',
          hint: [tags.join(' '), session, isAgent ? `nt-${n.id}` : '']
            .filter(Boolean)
            .join(' '),
          icon,
          content: bufferCache[n.id],
          run: () => goToNode(n)
        })
      })
    return cmds
  }, [
    addTerminal,
    addAgentNode,
    addChatNode,
    addSticky,
    addDino,
    addWebView,
    addBrowser,
    openFileDialog,
    addProject,
    fitView,
    persist,
    switchProject,
    goToNode,
    bufferCache,
    connectRemote,
    addSshTerminal
  ])

  // Build the palette's command list only when its inputs change — the inline `buildCommands()`
  // at the call site rebuilt the whole list (JSX icons for every node + project) on every Canvas
  // render while the palette was open. `nodes` is a dep because the list reads nodesRef.current;
  // capture-cache refreshes arrive via buildCommands' own identity (bufferCache is its dep).
  const paletteCommands = useMemo(
    () => (paletteOpen ? buildCommands() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- nodes stands in for nodesRef.current
    [paletteOpen, buildCommands, nodes]
  )

  return (
    <div className="canvas-root">
      <TabBar
        onSwitch={switchProject}
        onOpenWelcome={() => setWelcomeOpen(true)}
        onRename={renameProject}
        onSetFolder={setProjectFolder}
        onCloseProject={closeProject}
        onRemoteAccess={() => setRemoteDialogOpen(true)}
        onSetDefaultAccount={setProjectDefaultAccount}
      />

      <div className="top-banners">
        <AnnouncementBanner />
        {activeSshServer &&
          sshStatus[activeProjectId] &&
          sshStatus[activeProjectId] !== 'connected' &&
          (() => {
            const st = sshStatus[activeProjectId]
            const isError = st === 'error' || st === 'disconnected'
            const text =
              st === 'connecting'
                ? `Connecting to ${activeSshServer.label}…`
                : st === 'reconnecting'
                  ? `Reconnecting to ${activeSshServer.label}…`
                  : st === 'disconnected'
                    ? `Disconnected from ${activeSshServer.label}`
                    : `SSH connection error — ${activeSshServer.label}`
            return (
              <div
                title={`${activeSshServer.user}@${activeSshServer.host}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '6px 12px',
                  fontSize: 12,
                  color: 'var(--text)',
                  background: isError ? 'rgba(120,40,40,0.92)' : 'rgba(90,72,30,0.92)',
                  border: '1px solid var(--border)',
                  borderRadius: 8
                }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: isError ? '#ff6b6b' : '#e0b341'
                  }}
                />
                {text}
              </div>
            )
          })()}
      </div>
      <UpdateCard />

      <div
        className="sessions-icon-cluster"
        onMouseEnter={openSessionsPeek}
        onMouseLeave={closeSessionsPeekSoon}
      >
        <button title="Sessions (⌘⇧L)" onClick={onSessionsIconClick}>
          <IconSessions />
        </button>
      </div>

      <div className="controls-cluster">
        <button
          className="cluster-search"
          title="Command palette"
          onClick={() => setPaletteOpen(true)}
        >
          <span className="cluster-search__icon">⌕</span>
          <span className="kbd">⌘K</span>
        </button>
        <button title="Explorer (⌘⇧E)" onClick={() => setExplorerOpen(true)}>
          🗂
        </button>
        <button title="Source Control" onClick={() => setScOpen(true)}>
          ⎇
        </button>
        <button
          title="Settings (⌘,)"
          onClick={() => {
            setSettingsSection(undefined)
            setSettingsOpen(true)
          }}
        >
          ⚙
        </button>
        <button title="Keyboard shortcuts (⌘/)" onClick={() => setShortcutsOpen(true)}>
          ?
        </button>
      </div>

      <div className="flow-wrap" ref={flowWrapRef}>
        <ReactFlow
          nodes={allNodes}
          edges={displayEdges}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onEdgeDoubleClick={onEdgeDoubleClick}
          onMove={onMove}
          onNodeDragStart={() => (draggingRef.current = true)}
          onNodeDragStop={() => {
            draggingRef.current = false
            markDirty()
          }}
          onSelectionDragStart={() => (draggingRef.current = true)}
          onSelectionDragStop={() => {
            draggingRef.current = false
            markDirty()
          }}
          onPaneClick={() => setEphSel({})}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          onNodeDoubleClick={onNodeDoubleClick}
          minZoom={0.01}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={[1]}
          panOnScroll={!wheelZoom}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomActivationKeyCode={null}
          snapToGrid={settings.snapToGrid}
          snapGrid={[settings.gridSize, settings.gridSize]}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={settings.gridSize || GRID}
            size={2.5}
            color="#4a4a4a"
          />
          <Controls showInteractive={false} position="bottom-left" />
          <UsageIndicator />
          <StatusAwareMiniMap onNodeDoubleClick={goToNode} />
        </ReactFlow>

        {(!hasProjects || welcomeOpen) && (
          <WelcomeScreen
            onNewProject={() => {
              setWelcomeOpen(false)
              addProject()
            }}
            onOpenFolder={() => {
              // Keep the welcome screen up behind the native picker; dismiss it only once a
              // folder was actually chosen (cancel returns to the welcome screen).
              void addProjectFromFolder().then((opened) => {
                if (opened) setWelcomeOpen(false)
              })
            }}
            onCloneRepo={cloneRepo}
            onConnectSsh={() => setSshDialogOpen(true)}
            closedProjects={closedProjects.map((p) => ({ id: p.id, name: p.name, cwd: p.cwd }))}
            onReopen={reopenProject}
            onDeleteClosed={deleteProject}
            onClose={hasProjects ? () => setWelcomeOpen(false) : undefined}
          />
        )}

        <CloneRepoDialog
          open={cloneDialogOpen}
          onClose={() => setCloneDialogOpen(false)}
          onCloned={onRepoCloned}
        />

        {remoteConnId && (
          <div className="remote-session-overlay">
            <RemoteSessionView connectionId={remoteConnId} onClose={disconnectRemote} />
          </div>
        )}
      </div>

      {remoteDialogOpen && <RemoteAccessDialog onClose={() => setRemoteDialogOpen(false)} />}

      {sshDialogOpen && (
        <SshProjectDialog
          onCreate={createSshProject}
          onManage={() => {
            setSettingsSection('ssh')
            setSettingsOpen(true)
          }}
          onClose={() => setSshDialogOpen(false)}
        />
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {paletteOpen && (
        <CommandPalette
          commands={paletteCommands}
          fileIndex={fileIndex}
          onOpenFile={openProjectFile}
          onRevealFile={revealProjectFile}
          onQueryChange={onPaletteQuery}
          extraCommands={transcriptCommands}
          onClose={() => {
            setPaletteOpen(false)
            setTranscriptHits([])
            if (transcriptSearchTimer.current) clearTimeout(transcriptSearchTimer.current)
          }}
        />
      )}

      {settingsOpen && (
        <SettingsPage onClose={() => setSettingsOpen(false)} initialSection={settingsSection} />
      )}

      {scOpen && (
        <SourceControlPanel
          onClose={() => setScOpen(false)}
          onRunInTerminal={runInTerminal}
          onOpenDiff={openDiff}
          onOpenCommitDiff={openCommitDiff}
          onExplainCommit={explainCommit}
        />
      )}

      {shortcutsOpen && <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />}

      {explorerOpen && (
        <ExplorerPanel
          onClose={() => setExplorerOpen(false)}
          onOpenFile={(path, isSsh) => openFile(path, undefined, isSsh)}
          reveal={reveal}
        />
      )}

      <SessionsSidebar
        open={sessionsOpen}
        pinned={sessionsPinned}
        liveActiveNodes={liveActiveNodes}
        onTogglePin={toggleSessionsPin}
        onClose={() => {
          // Transient "hide for now" — does NOT touch the pin preference.
          setSessionsHover(false)
          setSessionsDismissed(true)
        }}
        onFocusNode={focusNodeById}
        onCloseSession={closeSession}
        onRenameSession={renameSession}
        onAiNameSession={aiNameSession}
        onAiNameGroup={aiNameGroup}
        onMoveToGroup={moveSessionToGroup}
        onReorder={reorderSession}
        onRowContextMenu={onRowContextMenu}
        onProjectContextMenu={onProjectContextMenu}
        onAddToProject={addToProject}
        onMouseEnter={openSessionsPeek}
        onMouseLeave={closeSessionsPeekSoon}
      />

      {confirm && (
        <ConfirmDialog
          message={confirm.message}
          confirmLabel={confirm.confirmLabel}
          cancelLabel={confirm.cancelLabel}
          danger={confirm.danger}
          onConfirm={confirm.onConfirm}
          onCancel={() => {
            confirm.onCancel?.()
            setConfirm(null)
          }}
        />
      )}

      {pendingPeer && (
        <ConfirmDialog
          message={
            `A device wants to access this machine.\n\n` +
            `Approve ONLY if you started this connection. The other device shows the same code:\n\n` +
            `        ${pendingPeer.sas ?? '— — —'}\n\n` +
            `If the codes don't match, deny it.`
          }
          confirmLabel="Allow"
          cancelLabel="Deny"
          danger={false}
          onConfirm={() => {
            window.nodeTerminal.remoteHost.approve(pendingPeer.id)
            setPendingPeer(null)
          }}
          onCancel={() => {
            window.nodeTerminal.remoteHost.reject(pendingPeer.id)
            setPendingPeer(null)
          }}
        />
      )}

      <UpgradeDialog />

      {remotePicker && (
        <RemotePicker
          x={remotePicker.x}
          y={remotePicker.y}
          onPick={(srv) => addSshTerminal(srv, { x: remotePicker.x, y: remotePicker.y })}
          onManage={() => {
            setSettingsSection('ssh')
            setSettingsOpen(true)
          }}
          onClose={() => setRemotePicker(null)}
        />
      )}

      {bindTarget && (
        <BindWorktreeDialog
          initialRepoPath={
            (nodesRef.current.find((n) => n.id === bindTarget)?.data.cwd as string) || ''
          }
          defaultPath={(repoPath, branch) =>
            computeWorktreePath(
              userDataDirRef.current,
              repoPath.split('/').pop() || 'repo',
              sanitizeWorktreeBranch(branch)
            )
          }
          onConfirm={confirmBind}
          onCancel={() => setBindTarget(null)}
        />
      )}

      {moveTarget && (
        <ConfirmDialog
          message="Move this terminal into the worktree? Its session restarts and any running process ends."
          confirmLabel="Move"
          danger={false}
          onConfirm={confirmMoveIntoWorktree}
          onCancel={() => setMoveTarget(null)}
        />
      )}

      {removeTarget && (
        <ConfirmDialog
          message={`Remove this worktree and delete its branch?${
            removeTarget.warning ? '\n\n⚠ ' + removeTarget.warning : ''
          }`}
          confirmLabel="Remove"
          danger
          onConfirm={confirmRemoveWorktree}
          onCancel={() => setRemoveTarget(null)}
        />
      )}

      {consentOpen && (
        <NotifyConsentDialog
          onEnable={() => {
            useSettings.getState().update({ notifyOnClaudeDone: true })
            void window.nodeTerminal.notify({
              title: 'Notifications enabled',
              body: "You'll be told when Claude Code finishes in the background.",
              nodeId: '',
              force: true
            })
            setConsentOpen(false)
          }}
          onDismiss={() => setConsentOpen(false)}
        />
      )}

      <Dock
        dirty={dirty}
        zoomPct={zoomPct}
        canUndo={pastRef.current.length > 0}
        canRedo={futureRef.current.length > 0}
        onUndo={undo}
        onRedo={redo}
        onAddTerminal={addTerminal}
        onAddSticky={addSticky}
        onAddDino={addDino}
        onAddAgent={(aid, accountId) => addAgentNode(aid, undefined, undefined, accountId)}
        onAddChat={() => addChatNode()}
        onOpenFile={() => void openFileDialog()}
        onAddRemote={() => openRemotePicker({ x: window.innerWidth / 2, y: window.innerHeight / 2 })}
        onConnectRemote={() => void connectRemote()}
        onSave={persist}
        onFitView={() => fitView({ padding: 0.2, duration: 300 })}
        onZoomIn={() => zoomIn({ duration: 150 })}
        onZoomOut={() => zoomOut({ duration: 150 })}
      />
    </div>
  )
}
