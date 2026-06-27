import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  addEdge,
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
  type Viewport
} from '@xyflow/react'
import type { Edge, Node } from '@xyflow/react'
import { TerminalNode, setMoveIntoWorktreeHandler } from '../nodes/TerminalNode'
import { StickyNode } from '../nodes/StickyNode'
import { GroupNode, setWorktreeActionHandler } from '../nodes/GroupNode'
import { EditorNode } from '../nodes/EditorNode'
import { DiffNode } from '../nodes/DiffNode'
import { DinoNode } from '../nodes/DinoNode'
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
import { ShortcutsPanel } from '../components/ShortcutsPanel'
import { UpdateCard } from '../components/UpdateCard'
import { AnnouncementBanner } from '../components/AnnouncementBanner'
import { ConfirmDialog } from '../components/ConfirmDialog'
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
import { transport } from '../terminal/local-transport'
import { prepareQuickOpenFiles, type QuickOpenIndexedFile } from '../lib/quickOpenSearch'
import { opensInEditor } from '../lib/openTarget'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import { useAgentNodes } from '../state/agentNodes'
import { SubagentNode } from '../nodes/SubagentNode'
import { LoopNode } from '../nodes/LoopNode'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import { computeWorktreePath, sanitizeWorktreeBranch } from '@shared/worktree'
import {
  agentConfig,
  hasHooks,
  canBranch,
  canTransferFrom,
  canContextLink,
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  type AgentId
} from '@shared/agents/config'
import { AgentIcon } from '../lib/agentIcons'
import { branchClaudeSession } from '../lib/claudeBranch'
import { useSettings } from '../state/settings'
import { useContextWindow } from '../state/contextWindow'
import { useSessionNaming } from '../state/sessionNaming'
import { useSshServers } from '../state/sshServers'
import { requireProOr } from '../state/upgradeGate'
import type { SshServer } from '@shared/ssh'
import {
  applyCanvasMutation,
  claudeLaunchCommand,
  COLLAPSED_HEIGHT,
  createAgentNode,
  createDinoNode,
  createDiffNode,
  createEditorNode,
  createSshTerminalNode,
  createStickyNode,
  createTerminalNode,
  duplicateNode,
  flowToNodeStates,
  groupSelectedNodes,
  nodeStatesToFlow,
  reorderNodeBefore,
  reparentNode,
  ungroupNodes,
  type CanvasNode
} from '../state/workspace'

const GRID = 24

// Stable identity for the common case of no subagent/loop fan-out, so the ephemeral
// memo doesn't allocate fresh arrays on every node change (e.g. each drag frame).
const NO_EPHEMERAL: { ephemeralNodes: CanvasNode[]; ephemeralEdges: Edge[] } = {
  ephemeralNodes: [],
  ephemeralEdges: []
}

export function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  // Persistent context links between Claude nodes (separate from ephemeral subagent/loop edges).
  const [linkEdges, setLinkEdges, onLinkEdgesChange] = useEdgesState<Edge>([])
  const linkEdgesRef = useRef<Edge[]>([])
  linkEdgesRef.current = linkEdges
  const [dirty, setDirty] = useState(false)
  const [zoomPct, setZoomPct] = useState(100)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [remotePicker, setRemotePicker] = useState<{ x: number; y: number } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [fileIndex, setFileIndex] = useState<QuickOpenIndexedFile[]>([])
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
  // A client has finished the handshake and is awaiting this host's approval (carries the SAS).
  const [pendingPeer, setPendingPeer] = useState<{ sas: string | null } | null>(null)
  const [confirm, setConfirm] = useState<{
    message: string
    onConfirm: () => void
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
  const hasProjects = useProjects((s) => s.projects.length > 0)
  nodesRef.current = nodes

  const nodeTypes = useMemo(
    () => ({
      terminal: withNodeBoundary(TerminalNode),
      sticky: withNodeBoundary(StickyNode),
      group: withNodeBoundary(GroupNode),
      editor: withNodeBoundary(EditorNode),
      diff: withNodeBoundary(DiffNode),
      subagent: withNodeBoundary(SubagentNode),
      loop: withNodeBoundary(LoopNode),
      dino: withNodeBoundary(DinoNode)
    }),
    []
  )

  // Ephemeral subagent nodes + edges (driven by Claude hooks; never persisted / no undo).
  // Laid out fanning below the parent Claude node.
  const agentById = useAgentNodes((s) => s.byId)
  const ephemeralPos = useAgentNodes((s) => s.positions)
  const ephSizes = useAgentNodes((s) => s.sizes)
  const ephExpanded = useAgentNodes((s) => s.expanded)
  const claudeById = useAgentStatus((s) => s.byId)
  // Selection state for ephemeral nodes (they live outside React Flow's managed nodes).
  const [ephSel, setEphSel] = useState<Record<string, boolean>>({})
  const { ephemeralNodes, ephemeralEdges } = useMemo(() => {
    // Common case: no /loop running and no subagents → return a stable empty result so
    // this memo (which depends on `nodes`, i.e. recomputes every drag frame) stays cheap
    // and doesn't churn array identity downstream.
    const hasLoops = Object.values(claudeById).some((s) => s.loop)
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
            subagentActivity: v.activity,
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
  }, [agentById, claudeById, ephemeralPos, ephSizes, ephExpanded, ephSel, nodes])

  // Merge the persisted nodes with the ephemeral ones once per change (not per render),
  // so React Flow's array-identity short-circuit holds while panning/zooming.
  const allNodes = useMemo(
    () => (ephemeralNodes.length ? [...nodes, ...ephemeralNodes] : nodes),
    [nodes, ephemeralNodes]
  )

  // Context-link edges, statically styled (no per-message activity in the pull model).
  const accent = settings.accent
  const displayEdges = useMemo(() => {
    const decorated = linkEdges.map((e) => {
      const sel = !!e.selected
      const stroke = sel ? '#ffffff' : accent
      return {
        ...e,
        type: 'default',
        sourceHandle: 'link-out',
        targetHandle: 'link-in',
        label: sel ? '⇄ context — ⌫ to remove' : '⇄ context',
        labelStyle: { fill: stroke, fontSize: 11, fontWeight: 600 },
        labelBgStyle: { fill: '#1c1c1e', fillOpacity: 0.85 },
        labelBgPadding: [6, 3] as [number, number],
        labelBgBorderRadius: 5,
        style: { stroke, strokeWidth: sel ? 3.5 : 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
        markerStart: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 }
      }
    })
    return ephemeralEdges.length ? [...decorated, ...ephemeralEdges] : decorated
  }, [linkEdges, ephemeralEdges, accent])

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
  // live state lives in React Flow — pass it through here).
  const liveActiveNodes = useMemo<SessionNodeInput[]>(
    () =>
      nodes
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
        })),
    [nodes]
  )

  // 1) Load the whole workspace once and hydrate the projects store.
  useEffect(() => {
    let cancelled = false
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
    loadingRef.current = true
    const flow = nodeStatesToFlow(project.nodes)
    setNodes(flow)
    setLinkEdges((project.bridges ?? []).map((b) => ({ id: b.id, source: b.source, target: b.target })))
    // Reset history for the newly loaded project.
    committedRef.current = flow
    pastRef.current = []
    futureRef.current = []
    bumpHist((v) => v + 1)
    viewportRef.current = project.viewport
    setViewport(project.viewport)
    setZoomPct(Math.round(project.viewport.zoom * 100))
    // Let load-induced changes settle before we start tracking edits as dirty.
    const t = setTimeout(() => {
      loadingRef.current = false
      // The broadcast effect early-returns while `loadingRef` is set and isn't re-triggered by the
      // reset, so push the freshly-loaded project's canvas once now — otherwise a connected client
      // keeps mirroring the previous project until the host's next edit. Benign with no client
      // attached (main only forwards to a live client).
      window.nodeTerminal.remoteHost.sendCanvasState({ nodes: flowToNodeStates(nodesRef.current) })
      // Consume a cross-project focus request (notification click on a background node).
      const pending = pendingFocusRef.current
      if (pending) {
        pendingFocusRef.current = null
        const node = nodesRef.current.find((n) => n.id === pending)
        if (node) {
          setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === pending })))
          goToNode(node)
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
          linkEdgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target }))
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
  // change, so a connected client mirrors the layout. Main holds the latest snapshot regardless
  // of whether a client is connected and only broadcasts when one is — so this is safe to send
  // unconditionally (no host-mode flag in the renderer). Skips programmatic loads to avoid a
  // redundant push on project switch (the post-load value is captured by the next real change).
  useEffect(() => {
    if (loadingRef.current) return
    const t = setTimeout(() => {
      window.nodeTerminal.remoteHost.sendCanvasState({ nodes: flowToNodeStates(nodesRef.current) })
    }, 120)
    return () => clearTimeout(t)
  }, [nodes])

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

  // Context links connect two context-link-capable agent sessions (currently Claude only).
  const canLinkNode = useCallback(
    (id: string) => {
      const a = agentIdOf(id)
      return !!a && canContextLink(a)
    },
    [agentIdOf]
  )

  // Draw a context link between two context-link-capable nodes.
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      if (!canLinkNode(c.source) || !canLinkNode(c.target)) return
      // No duplicate link (in either direction).
      const exists = linkEdgesRef.current.some(
        (e) =>
          (e.source === c.source && e.target === c.target) ||
          (e.source === c.target && e.target === c.source)
      )
      if (exists) return
      setLinkEdges((es) =>
        addEdge(
          { id: `bridge-${c.source}-${c.target}`, source: c.source!, target: c.target!, type: 'default' },
          es
        )
      )
      markDirty()
      // Discovery: tell each idle endpoint it is now linked (skip a node mid-turn so we don't
      // interrupt it — the skill stays discoverable on its next relevant need).
      const status = useAgentStatus.getState().byId
      const titleOf = (id: string) =>
        (nodes.find((n) => n.id === id)?.data.title as string) || 'a linked node'
      const note = (selfId: string, otherId: string) => {
        if (status[selfId]?.state === 'working') return
        void window.nodeTerminal.pty.sendText(
          selfId,
          `[nodeterm] You are now linked to "${titleOf(otherId)}". Use the get-linked-context skill to read its context when you need it.`
        )
      }
      note(c.source, c.target)
      note(c.target, c.source)
    },
    [canLinkNode, setLinkEdges, markDirty, nodes]
  )

  // Double-click a context link to remove it (ephemeral subagent/loop edges are left alone).
  const onEdgeDoubleClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      if (!linkEdgesRef.current.some((b) => b.id === edge.id)) return
      setLinkEdges((es) => es.filter((b) => b.id !== edge.id))
      markDirty()
    },
    [setLinkEdges, markDirty]
  )

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
      return { id, title: (n?.data.title as string) || id, cwd: (n?.data.cwd as string) || '' }
    }
    const map: Record<string, { id: string; title: string; cwd: string }[]> = {}
    for (const e of valid) {
      ;(map[e.source] ??= []).push(infoOf(e.target))
      ;(map[e.target] ??= []).push(infoOf(e.source))
    }
    const t = setTimeout(() => void window.nodeTerminal.contextLink.setLinks(map), 150)
    return () => clearTimeout(t)
  }, [linkEdges, nodes, setLinkEdges])

  // Reflect Claude nodes with unread output as a macOS Dock badge count (across all projects).
  useEffect(() => {
    const count = Object.values(claudeById).filter((s) => s?.unread).length
    window.nodeTerminal.setBadgeCount(count)
  }, [claudeById])

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
  useEffect(() => {
    const wrap = flowWrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return // pinch (ctrl+wheel) or Cmd/Ctrl+scroll = zoom
      e.preventDefault()
      e.stopPropagation()
      const { x, y, zoom } = getViewport()
      const rect = wrap.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      // Cap a single event's influence so a chunky mouse-wheel tick doesn't jump zoom levels.
      const d = Math.max(-50, Math.min(50, e.deltaY))
      const next = Math.min(2, Math.max(0.2, zoom * Math.exp(-d * 0.01)))
      if (next === zoom) return
      const k = next / zoom
      setViewport({ x: px - (px - x) * k, y: py - (py - y) * k, zoom: next })
    }
    wrap.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => wrap.removeEventListener('wheel', onWheel, { capture: true })
  }, [getViewport, setViewport])

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
      const cwd = cwdForNewNodeIn(groupId) ?? useProjects.getState().getProject(activeProjectId)?.cwd
      setNodes((ns) => {
        const node = createTerminalNode(ns.length, cwd, center ?? viewCenter(), initialCommand)
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
    const offer = window.prompt("Paste the host's pairing code:")?.trim()
    if (!offer) return
    try {
      const connectionId = await window.nodeTerminal.remoteClient.connect(offer)
      mountRemoteMirror(connectionId)
    } catch (err) {
      window.alert(`Could not connect: ${(err as Error).message}`)
    }
  }, [mountRemoteMirror])

  /** Open a file as a code editor node on the canvas. */
  const openFile = useCallback(
    (filePath: string, center?: { x: number; y: number }) => {
      setNodes((ns) => [...ns, createEditorNode(ns.length, filePath, center ?? viewCenter())])
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
      const cwd = useProjects.getState().getProject(activeProjectId)?.cwd
      if (!cwd) return
      setNodes((ns) => [...ns, createDiffNode(ns.length, cwd, relPath, staged, viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter]
  )

  /** Open a parent↔commit diff node for a file from the history graph. */
  const openCommitDiff = useCallback(
    (relPath: string, commitOid: string) => {
      const cwd = useProjects.getState().getProject(activeProjectId)?.cwd
      if (!cwd) return
      setNodes((ns) => [...ns, createDiffNode(ns.length, cwd, relPath, false, viewCenter(), commitOid)])
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter]
  )

  /** Open a Claude node seeded with a commit-explanation prompt. */
  const explainCommit = useCallback(
    (prompt: string) => {
      const cwd = useProjects.getState().getProject(activeProjectId)?.cwd
      setNodes((ns) => [...ns, createAgentNode('claude', ns.length, cwd, viewCenter(), prompt)])
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

  const cloneRepo = useCallback(async () => {
    const url = window.prompt('Repository URL (https:// or git@):')
    if (!url) return
    const parent = await window.nodeTerminal.dialog.selectFolder()
    if (!parent) return
    const r = await window.nodeTerminal.git.clone(parent, url)
    if (!r.ok) {
      window.alert(`Clone failed: ${r.message}`)
      return
    }
    const name = url.split('/').pop()?.replace(/\.git$/, '') || 'repo'
    commitActiveToStore()
    const project = useProjects.getState().addProject(name, r.message)
    useProjects.getState().setActive(project.id)
    void writeDisk()
  }, [commitActiveToStore, writeDisk])

  const addSticky = useCallback(
    (center?: { x: number; y: number }) => {
      setNodes((ns) => [...ns, createStickyNode(ns.length, center ?? viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, viewCenter]
  )

  const addDino = useCallback(
    (center?: { x: number; y: number }) => {
      setNodes((ns) => [...ns, createDinoNode(ns.length, center ?? viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, viewCenter]
  )

  const addAgentNode = useCallback(
    (agentId: AgentId, center?: { x: number; y: number }, groupId?: string) => {
      const cwd = cwdForNewNodeIn(groupId) ?? useProjects.getState().getProject(activeProjectId)?.cwd
      setNodes((ns) => {
        const node = createAgentNode(agentId, ns.length, cwd, center ?? viewCenter())
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
        // Remote terminals have no local persistent session — only destroy local ones.
        if (n.type === 'terminal' && !n.data.remote) transport.destroy(n.id)
        // Permanent deletion → drop the node's persisted agent status (sessionId/session/
        // unread). Node unmount no longer does this, so deletion must.
        useAgentStatus.getState().remove(n.id)
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

  // Delete / Backspace asks for confirmation, then deletes the selected nodes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = (document.activeElement?.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      const ids = nodesRef.current.filter((n) => n.selected).map((n) => n.id)
      if (!ids.length) {
        // No node selected → remove any selected context link(s).
        const edgeIds = linkEdgesRef.current.filter((b) => b.selected).map((b) => b.id)
        if (edgeIds.length) {
          e.preventDefault()
          const drop = new Set(edgeIds)
          setLinkEdges((es) => es.filter((b) => !drop.has(b.id)))
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
    async (nodeId: string) => {
      const source = nodesRef.current.find((n) => n.id === nodeId) as CanvasNode | undefined
      if (!source) return
      const known = useAgentStatus.getState().byId[nodeId]?.sessionId
      let originalId = known
      if (known) {
        await window.nodeTerminal.pty.sendText(nodeId, '/branch')
      } else {
        const res = await branchClaudeSession(nodeId)
        if (!res.ok || !res.originalId) {
          setConfirm({ message: res.error ?? 'Branch failed.', onConfirm: () => setConfirm(null) })
          return
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
        source.data.cwd
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
        prompt
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
      const w = node.measured?.width ?? (node.width as number) ?? 0
      const h = node.measured?.height ?? (node.height as number) ?? 0
      setCenter(node.position.x + w / 2, node.position.y + h / 2, {
        zoom: Math.max(getZoom(), 1),
        duration: 300
      })
    },
    [setCenter, getZoom]
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
      ...(ids.length > 1
        ? ([
            { label: 'Group selection', icon: <IconGroup />, onClick: () => groupSelection(ids) },
            { type: 'separator' }
          ] as MenuItem[])
        : []),
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

  const groupItems = useCallback(
    (groupId: string): MenuItem[] => [
      { type: 'label', label: 'Group' },
      {
        label: 'New terminal in group',
        icon: <IconTerminal />,
        onClick: () => addTerminal(undefined, undefined, groupId)
      },
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
    [setNodesColor, ungroup, groupHasWorktree, bindGroupToWorktree, addTerminal]
  )

  const onPaneContextMenu = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      e.preventDefault()
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      const disabled = useSettings.getState().settings.disabledAgents
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: 'New terminal', icon: <IconTerminal />, onClick: () => addTerminal(at) },
          ...BUILTIN_AGENT_IDS.filter((aid) => !disabled.includes(aid)).map(
            (aid): MenuItem => ({
              label: `New ${AGENT_CONFIG[aid].label}`,
              icon: <AgentIcon agentId={aid} />,
              onClick: () => addAgentNode(aid, at)
            })
          ),
          ...useSettings
            .getState()
            .settings.customAgents.filter((c) => !disabled.includes(c.id))
            .map(
              (c): MenuItem => ({
                label: `New ${c.label}`,
                icon: <AgentIcon agentId={c.id} />,
                onClick: () => addAgentNode(c.id, at)
              })
            ),
          { label: 'New sticky note', icon: <IconNote />, onClick: () => addSticky(at) },
          { label: 'New dino game', icon: <IconDino />, onClick: () => addDino(at) },
          { label: 'Open file…', icon: <IconEditor />, onClick: () => void openFileDialog(at) },
          {
            label: 'New remote…',
            icon: <IconTerminal />,
            onClick: () => openRemotePicker({ x: e.clientX, y: e.clientY })
          },
          { type: 'separator' },
          { label: 'Select all', icon: <IconSelectAll />, onClick: selectAll },
          { label: 'Fit view', icon: <IconFit />, onClick: () => fitView({ padding: 0.2, duration: 300 }) }
        ]
      })
    },
    [
      screenToFlowPosition,
      addTerminal,
      addAgentNode,
      addSticky,
      addDino,
      openFileDialog,
      openRemotePicker,
      selectAll,
      fitView
    ]
  )

  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: Node) => {
      e.preventDefault()
      const items = node.type === 'group' ? groupItems(node.id) : selectionItems(targetIds(node))
      setMenu({ x: e.clientX, y: e.clientY, items })
    },
    [groupItems, selectionItems, targetIds]
  )

  const onSelectionContextMenu = useCallback(
    (e: React.MouseEvent, selected: Node[]) => {
      e.preventDefault()
      setMenu({ x: e.clientX, y: e.clientY, items: selectionItems(selected.map((n) => n.id)) })
    },
    [selectionItems]
  )

  // Title/color/text edits go through updateNodeData; watch them so they persist too.
  // Computed only when the `nodes` array changes (not on every Canvas render — e.g. zoom
  // readout, hover, menu — which would otherwise rebuild this whole string each frame).
  const dataSignature = useMemo(
    () =>
      nodes
        .map(
          (n) =>
            `${n.id}:${n.data.title}:${n.data.color}:${n.data.text ?? ''}:${
              n.data.collapsed ? 1 : 0
            }:${((n.data.tags as string[]) ?? []).join(',')}`
        )
        .join('|'),
    [nodes]
  )
  useEffect(() => {
    markDirty()
  }, [dataSignature, markDirty])

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

  useEffect(() => window.nodeTerminal.onFocusNode(focusNodeById), [focusNodeById])

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
            transport.destroy(id)
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
        setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, title } } : n)))
        markDirty()
      } else {
        useProjects.getState().renameNode(projectId, id, title)
        void writeDisk()
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
              const t = window.prompt('Rename session', '')
              if (t && t.trim()) renameSession(projectId, id, t.trim())
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
          if (e.state) cs.setState(e.nodeId, e.state, e.agentId)
          if (e.newTurn) an.clearForParent(e.nodeId) // genuine new turn → drop the previous fan-out
          if (e.newTurn && e.task) {
            // Prompt-prefix fallback for /loop|/schedule|/cron when the natural-language
            // phrasing doesn't trigger the tool-based (recurring) detection.
            const m = e.task.match(/^\s*\/(loop|schedule|cron)\b/)
            if (m) cs.setLoop(e.nodeId, true, m[1] as 'loop' | 'schedule' | 'cron', { task: e.task })
          }
          if (e.state === 'done') {
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
          if (e.recurringKind)
            cs.setLoop(e.nodeId, true, e.recurringKind, { schedule: e.schedule, task: e.task })
          break
        case 'session':
          if (e.sessionTitle) cs.setSession(e.nodeId, e.sessionTitle)
          if (e.sessionPhase === 'start') cs.setState(e.nodeId, undefined, e.agentId)
          if (e.sessionPhase === 'end') {
            cs.setState(e.nodeId, undefined, e.agentId)
            cs.setLoop(e.nodeId, false)
            an.clearForParent(e.nodeId)
          }
          break
      }
    })
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

  const addProject = useCallback(() => {
    commitActiveToStore()
    const project = useProjects.getState().addProject()
    useProjects.getState().setActive(project.id)
    void writeDisk()
  }, [commitActiveToStore, writeDisk])

  const addProjectFromFolder = useCallback(async () => {
    const folder = await window.nodeTerminal.dialog.selectFolder()
    if (!folder) return
    commitActiveToStore()
    // A folder maps to one project: reuse the existing one (with its nodes) if present.
    const existing = useProjects.getState().projects.find((p) => p.cwd === folder)
    if (existing) {
      useProjects.getState().setActive(existing.id)
    } else {
      const name = folder.split('/').filter(Boolean).pop() || 'Project'
      const project = useProjects.getState().addProject(name, folder)
      useProjects.getState().setActive(project.id)
    }
    void writeDisk()
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

  const deleteProject = useCallback(
    (id: string) => {
      const store = useProjects.getState()
      if (id === store.activeProjectId) commitActiveToStore()
      // End the tmux sessions of every terminal in the deleted project, and drop their
      // persisted agent status (node unmount no longer removes it).
      store.getProject(id)?.nodes.forEach((n) => {
        if ((n.kind ?? 'terminal') === 'terminal') transport.destroy(n.id)
        useAgentStatus.getState().remove(n.id)
      })
      store.deleteProject(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
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
      { id: 'new-sticky', label: 'New sticky note', icon: <IconNote />, run: () => addSticky() },
      { id: 'new-dino', label: 'New dino game', icon: <IconDino />, run: () => addDino() },
      { id: 'open-file', label: 'Open file…', icon: <IconEditor />, run: () => void openFileDialog() },
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
        cmds.push({
          id: `node-${n.id}`,
          label: `Go to ${n.data.title}`,
          hint: [tags.join(' '), session, isAgent ? `nt-${n.id}` : '']
            .filter(Boolean)
            .join(' '),
          icon: <IconJump />,
          content: bufferCache[n.id],
          run: () => goToNode(n)
        })
      })
    return cmds
  }, [
    addTerminal,
    addAgentNode,
    addSticky,
    addDino,
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

  return (
    <div className="canvas-root">
      <TabBar
        onSwitch={switchProject}
        onOpenWelcome={() => setWelcomeOpen(true)}
        onRename={renameProject}
        onSetFolder={setProjectFolder}
        onDelete={deleteProject}
        onRemoteAccess={() => setRemoteDialogOpen(true)}
      />

      <div className="top-banners">
        <AnnouncementBanner />
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
          onEdgesChange={onLinkEdgesChange}
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
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null}
          selectionOnDrag
          selectionMode={SelectionMode.Partial}
          panOnDrag={[1]}
          panOnScroll
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
          <MiniMap
            className="minimap"
            position="bottom-right"
            pannable
            zoomable
            maskColor="rgba(10,12,18,0.6)"
            nodeColor={(n) => (n.data as { color?: string })?.color ?? '#0a84ff'}
            nodeStrokeColor={(n) => {
              const st = useAgentStatus.getState().byId[n.id]
              if (st?.state === 'working') return '#30d158'
              if (st?.state === 'waiting' || st?.state === 'blocked') return '#ff9f0a'
              if (st?.unread) return '#0a84ff'
              return (n.data as { color?: string })?.color ?? '#0a84ff'
            }}
          />
        </ReactFlow>

        {(!hasProjects || welcomeOpen) && (
          <WelcomeScreen
            onNewProject={() => {
              setWelcomeOpen(false)
              addProject()
            }}
            onOpenFolder={() => {
              setWelcomeOpen(false)
              void addProjectFromFolder()
            }}
            onCloneRepo={() => {
              setWelcomeOpen(false)
              void cloneRepo()
            }}
            onClose={hasProjects ? () => setWelcomeOpen(false) : undefined}
          />
        )}

        {remoteConnId && (
          <div className="remote-session-overlay">
            <RemoteSessionView connectionId={remoteConnId} onClose={disconnectRemote} />
          </div>
        )}
      </div>

      {remoteDialogOpen && <RemoteAccessDialog onClose={() => setRemoteDialogOpen(false)} />}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {paletteOpen && (
        <CommandPalette
          commands={buildCommands()}
          fileIndex={fileIndex}
          onOpenFile={openProjectFile}
          onRevealFile={revealProjectFile}
          onClose={() => setPaletteOpen(false)}
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
        <ExplorerPanel onClose={() => setExplorerOpen(false)} onOpenFile={openFile} reveal={reveal} />
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
          onCancel={() => setConfirm(null)}
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
            window.nodeTerminal.remoteHost.approve()
            setPendingPeer(null)
          }}
          onCancel={() => {
            window.nodeTerminal.remoteHost.reject()
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
        onAddAgent={(aid) => addAgentNode(aid)}
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
