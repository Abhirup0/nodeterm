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
import { TerminalNode } from '../nodes/TerminalNode'
import { StickyNode } from '../nodes/StickyNode'
import { GroupNode } from '../nodes/GroupNode'
import { EditorNode } from '../nodes/EditorNode'
import { DiffNode } from '../nodes/DiffNode'
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
  IconJump,
  IconMarkdown,
  IconNote,
  IconProject,
  IconSave,
  IconSelectAll,
  IconSwitch,
  IconTerminal,
  IconTrash,
  IconUngroup
} from '../components/icons'
import { SettingsPanel } from '../components/SettingsPanel'
import { SourceControlPanel } from '../components/SourceControlPanel'
import { WelcomeScreen } from '../components/WelcomeScreen'
import { ShortcutsPanel } from '../components/ShortcutsPanel'
import { UpdateCard } from '../components/UpdateCard'
import { AnnouncementBanner } from '../components/AnnouncementBanner'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { NotifyConsentDialog } from '../components/NotifyConsentDialog'
import { ExplorerPanel } from '../components/ExplorerPanel'
import { UsageIndicator } from '../components/UsageIndicator'
import { transport } from '../terminal/local-transport'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import { useAgentNodes } from '../state/agentNodes'
import { SubagentNode } from '../nodes/SubagentNode'
import { LoopNode } from '../nodes/LoopNode'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import {
  agentConfig,
  hasHooks,
  canBranch,
  canBridge,
  AGENT_CONFIG,
  BUILTIN_AGENT_IDS,
  type AgentId
} from '@shared/agents/config'
import { AgentIcon } from '../lib/agentIcons'
import { branchClaudeSession } from '../lib/claudeBranch'
import { useSettings } from '../state/settings'
import { useContextWindow } from '../state/contextWindow'
import {
  claudeLaunchCommand,
  COLLAPSED_HEIGHT,
  createAgentNode,
  createDiffNode,
  createEditorNode,
  createStickyNode,
  createTerminalNode,
  duplicateNode,
  flowToNodeStates,
  groupSelectedNodes,
  nodeStatesToFlow,
  setBridgeConfigPath,
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
  // Persistent bridge links between Claude nodes (separate from ephemeral subagent/loop edges).
  const [bridgeEdges, setBridgeEdges, onBridgeEdgesChange] = useEdgesState<Edge>([])
  const bridgeEdgesRef = useRef<Edge[]>([])
  bridgeEdgesRef.current = bridgeEdges
  // Transient per-edge activity (count + paused flag) shown while messages flow.
  const [bridgeActivity, setBridgeActivity] = useState<
    Record<string, { count: number; stopped: boolean }>
  >({})
  const [dirty, setDirty] = useState(false)
  const [zoomPct, setZoomPct] = useState(100)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  // Cached visible-buffer text per terminal, for command-palette content search.
  const [bufferCache, setBufferCache] = useState<Record<string, string>>({})
  const captureTsRef = useRef<Record<string, number>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [scOpen, setScOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [explorerOpen, setExplorerOpen] = useState(false)
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
      loop: withNodeBoundary(LoopNode)
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

  // Bridge edges decorated with live activity (count badge + animation while messaging).
  const accent = settings.accent
  const displayEdges = useMemo(() => {
    const decorated = bridgeEdges.map((e) => {
      const act = bridgeActivity[e.id]
      const sel = !!e.selected
      const stroke = sel ? '#ffffff' : act?.stopped ? '#ff9f0a' : accent
      return {
        ...e,
        type: 'default',
        sourceHandle: 'bridge-out',
        targetHandle: 'bridge-in',
        animated: !!act && !act.stopped,
        label: act
          ? act.stopped
            ? `⇄ paused (${act.count})`
            : `⇄ ${act.count}`
          : sel
            ? '⇄ bridge — ⌫ to remove'
            : '⇄ bridge',
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
  }, [bridgeEdges, bridgeActivity, ephemeralEdges, accent])

  // 1) Load the whole workspace once and hydrate the projects store.
  useEffect(() => {
    let cancelled = false
    // Bridge MCP config path → new Claude nodes launch with `--mcp-config` (Session Bridge).
    void window.nodeTerminal.bridge.configPath().then((p) => {
      if (!cancelled && p) setBridgeConfigPath(p)
    })
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
    setBridgeEdges((project.bridges ?? []).map((b) => ({ id: b.id, source: b.source, target: b.target })))
    setBridgeActivity({})
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
          bridgeEdgesRef.current.map((e) => ({ id: e.id, source: e.source, target: e.target }))
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

  // Bridge links connect two bridge-capable agent sessions (currently Claude only).
  const canBridgeNode = useCallback(
    (id: string) => {
      const a = agentIdOf(id)
      return !!a && canBridge(a)
    },
    [agentIdOf]
  )

  // Draw a bridge link between two bridge-capable nodes (the connection that lets them message).
  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target || c.source === c.target) return
      if (!canBridgeNode(c.source) || !canBridgeNode(c.target)) return
      // No duplicate link (in either direction).
      const exists = bridgeEdgesRef.current.some(
        (e) =>
          (e.source === c.source && e.target === c.target) ||
          (e.source === c.target && e.target === c.source)
      )
      if (exists) return
      setBridgeEdges((es) =>
        addEdge(
          { id: `bridge-${c.source}-${c.target}`, source: c.source!, target: c.target!, type: 'default' },
          es
        )
      )
      markDirty()
    },
    [canBridgeNode, setBridgeEdges, markDirty]
  )

  // Double-click a bridge link to remove it (ephemeral subagent/loop edges are left alone).
  const onEdgeDoubleClick = useCallback(
    (_e: React.MouseEvent, edge: Edge) => {
      if (!bridgeEdgesRef.current.some((b) => b.id === edge.id)) return
      setBridgeEdges((es) => es.filter((b) => b.id !== edge.id))
      markDirty()
    },
    [setBridgeEdges, markDirty]
  )

  // Prune links whose endpoints were deleted, then push the topology to main (debounced) so
  // the bridge MCP server can resolve `list_bridge_nodes` / route `send_to_bridge`.
  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id))
    const valid = bridgeEdges.filter((e) => ids.has(e.source) && ids.has(e.target))
    if (valid.length !== bridgeEdges.length) {
      setBridgeEdges(valid)
      return // re-runs with the pruned set
    }
    const titleOf = (id: string) =>
      (nodes.find((n) => n.id === id)?.data.title as string) || id
    const topo: Record<string, { id: string; title: string }[]> = {}
    for (const e of valid) {
      ;(topo[e.source] ??= []).push({ id: e.target, title: titleOf(e.target) })
      ;(topo[e.target] ??= []).push({ id: e.source, title: titleOf(e.source) })
    }
    const t = setTimeout(() => void window.nodeTerminal.bridge.setTopology(topo), 150)
    return () => clearTimeout(t)
  }, [bridgeEdges, nodes, setBridgeEdges])

  // A bridge message was delivered (or paused): pulse the matching edge with a live count.
  useEffect(() => {
    return window.nodeTerminal.bridge.onMessage((m) => {
      const edge = bridgeEdgesRef.current.find(
        (e) =>
          (e.source === m.from && e.target === m.to) || (e.source === m.to && e.target === m.from)
      )
      if (!edge) return
      const id = edge.id
      setBridgeActivity((prev) => ({ ...prev, [id]: { count: m.count, stopped: !!m.stopped } }))
      // Clear the pulse after a beat (keep the paused flag visible a little longer).
      const ttl = m.stopped ? 8000 : 2500
      window.setTimeout(() => {
        setBridgeActivity((prev) => {
          const next = { ...prev }
          delete next[id]
          return next
        })
      }, ttl)
    })
  }, [])

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

  // Pinch-zoom (trackpad / ctrl+wheel) must keep working even over a focused terminal, which
  // carries `nowheel` so plain scroll stays inside xterm. React Flow ignores wheel over a
  // nowheel element, so we zoom-to-cursor manually there; on open canvas React Flow handles it.
  useEffect(() => {
    const wrap = flowWrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return // only the pinch gesture (browsers deliver it as ctrl+wheel)
      const target = e.target as Element | null
      if (!target?.closest('.nowheel')) return // open canvas → leave it to React Flow
      e.preventDefault()
      e.stopPropagation()
      const { x, y, zoom } = getViewport()
      const rect = wrap.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const next = Math.min(2, Math.max(0.2, zoom * Math.exp(-e.deltaY * 0.01)))
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

  const addTerminal = useCallback(
    (center?: { x: number; y: number }, initialCommand?: string) => {
      const cwd = useProjects.getState().getProject(activeProjectId)?.cwd
      setNodes((ns) => [
        ...ns,
        createTerminalNode(ns.length, cwd, center ?? viewCenter(), initialCommand)
      ])
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter]
  )

  /** Open a new terminal that runs a command on start (e.g. gh auth login). */
  const runInTerminal = useCallback((cmd: string) => addTerminal(undefined, cmd), [addTerminal])

  /** Open a file as a code editor node on the canvas. */
  const openFile = useCallback(
    (filePath: string, center?: { x: number; y: number }) => {
      setNodes((ns) => [...ns, createEditorNode(ns.length, filePath, center ?? viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, viewCenter]
  )

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

  const addAgentNode = useCallback(
    (agentId: AgentId, center?: { x: number; y: number }) => {
      const cwd = useProjects.getState().getProject(activeProjectId)?.cwd
      setNodes((ns) => [...ns, createAgentNode(agentId, ns.length, cwd, center ?? viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter]
  )
  // Kept as a thin wrapper so existing callers + the ⌘⇧C shortcut keep working.
  const addClaude = useCallback(
    (center?: { x: number; y: number }) => addAgentNode('claude', center),
    [addAgentNode]
  )

  // ⌘T = new terminal, ⌘⇧C = new Claude Code (ignored while typing in a field/terminal).
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
        addClaude()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [addTerminal, addClaude])

  // ---- multi-node actions (context menu) ----
  const deleteNodes = useCallback(
    (ids: string[]) => {
      const set = new Set(ids)
      nodesRef.current.forEach((n) => {
        if (set.has(n.id) && n.type === 'terminal') transport.destroy(n.id)
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
        // No node selected → remove any selected bridge link(s).
        const edgeIds = bridgeEdgesRef.current.filter((b) => b.selected).map((b) => b.id)
        if (edgeIds.length) {
          e.preventDefault()
          const drop = new Set(edgeIds)
          setBridgeEdges((es) => es.filter((b) => !drop.has(b.id)))
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
  }, [deleteNodes, setBridgeEdges, markDirty])

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
        setSettingsOpen(true)
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'e') {
        e.preventDefault()
        setExplorerOpen((v) => !v)
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
  }, [])

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
      { type: 'colors', onPick: (c) => setNodesColor([groupId], c) },
      { type: 'separator' },
      { label: 'Ungroup', icon: <IconUngroup />, onClick: () => ungroup(groupId) },
      { label: 'Delete (keeps nodes)', icon: <IconTrash />, danger: true, onClick: () => ungroup(groupId) }
    ],
    [setNodesColor, ungroup]
  )

  const onPaneContextMenu = useCallback(
    (e: MouseEvent | React.MouseEvent) => {
      e.preventDefault()
      const at = screenToFlowPosition({ x: e.clientX, y: e.clientY })
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: 'New terminal', icon: <IconTerminal />, onClick: () => addTerminal(at) },
          ...BUILTIN_AGENT_IDS.map(
            (aid): MenuItem => ({
              label: `New ${AGENT_CONFIG[aid].label}`,
              icon: <AgentIcon agentId={aid} />,
              onClick: () => addAgentNode(aid, at)
            })
          ),
          ...useSettings.getState().settings.customAgents.map(
            (c): MenuItem => ({
              label: `New ${c.label}`,
              icon: <AgentIcon agentId={c.id} />,
              onClick: () => addAgentNode(c.id, at)
            })
          ),
          { label: 'New sticky note', icon: <IconNote />, onClick: () => addSticky(at) },
          { label: 'Open file…', icon: <IconEditor />, onClick: () => void openFileDialog(at) },
          { type: 'separator' },
          { label: 'Select all', icon: <IconSelectAll />, onClick: selectAll },
          { label: 'Fit view', icon: <IconFit />, onClick: () => fitView({ padding: 0.2, duration: 300 }) }
        ]
      })
    },
    [screenToFlowPosition, addTerminal, addAgentNode, addSticky, openFileDialog, selectAll, fitView]
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
    // Notification context = the node's folder name (or its title), like REF's worktree label.
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
      // REF-style: "<folder> — Claude finished" + last assistant message as the body.
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
      // End the tmux sessions of every terminal in the deleted project.
      store.getProject(id)?.nodes.forEach((n) => {
        if ((n.kind ?? 'terminal') === 'terminal') transport.destroy(n.id)
      })
      store.deleteProject(id)
      void writeDisk()
    },
    [commitActiveToStore, writeDisk]
  )

  const buildCommands = useCallback((): Command[] => {
    const cmds: Command[] = [
      { id: 'new-term', label: 'New terminal', section: 'Create', icon: <IconTerminal />, run: () => addTerminal() },
      ...BUILTIN_AGENT_IDS.map(
        (aid): Command => ({
          id: `new-${aid}`,
          label: `New ${AGENT_CONFIG[aid].label}`,
          icon: <AgentIcon agentId={aid} />,
          run: () => addAgentNode(aid)
        })
      ),
      ...useSettings.getState().settings.customAgents.map(
        (c): Command => ({
          id: `new-${c.id}`,
          label: `New ${c.label}`,
          icon: <AgentIcon agentId={c.id} />,
          run: () => addAgentNode(c.id)
        })
      ),
      { id: 'new-sticky', label: 'New sticky note', icon: <IconNote />, run: () => addSticky() },
      { id: 'open-file', label: 'Open file…', icon: <IconEditor />, run: () => void openFileDialog() },
      { id: 'new-project', label: 'New project', icon: <IconProject />, run: () => addProject() },
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
    openFileDialog,
    addProject,
    fitView,
    persist,
    switchProject,
    goToNode,
    bufferCache
  ])

  return (
    <div className="canvas-root">
      <TabBar
        onSwitch={switchProject}
        onAdd={addProject}
        onAddFromFolder={addProjectFromFolder}
        onRename={renameProject}
        onSetFolder={setProjectFolder}
        onDelete={deleteProject}
      />

      <div className="top-banners">
        <AnnouncementBanner />
      </div>
      <UpdateCard />

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
        <button title="Settings (⌘,)" onClick={() => setSettingsOpen(true)}>
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
          onEdgesChange={onBridgeEdgesChange}
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
          zoomOnPinch
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

        {!hasProjects && (
          <WelcomeScreen
            onNewProject={addProject}
            onOpenFolder={addProjectFromFolder}
            onCloneRepo={cloneRepo}
          />
        )}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {paletteOpen && (
        <CommandPalette commands={buildCommands()} onClose={() => setPaletteOpen(false)} />
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      {scOpen && (
        <SourceControlPanel
          onClose={() => setScOpen(false)}
          onRunInTerminal={runInTerminal}
          onOpenDiff={openDiff}
        />
      )}

      {shortcutsOpen && <ShortcutsPanel onClose={() => setShortcutsOpen(false)} />}

      {explorerOpen && (
        <ExplorerPanel onClose={() => setExplorerOpen(false)} onOpenFile={openFile} />
      )}

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
        onAddAgent={(aid) => addAgentNode(aid)}
        onOpenFile={() => void openFileDialog()}
        onSave={persist}
        onFitView={() => fitView({ padding: 0.2, duration: 300 })}
        onZoomIn={() => zoomIn({ duration: 150 })}
        onZoomOut={() => zoomOut({ duration: 150 })}
      />
    </div>
  )
}
