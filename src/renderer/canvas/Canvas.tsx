import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useNodesState,
  useReactFlow,
  type Viewport
} from '@xyflow/react'
import type { Node } from '@xyflow/react'
import { TerminalNode } from '../nodes/TerminalNode'
import { StickyNode } from '../nodes/StickyNode'
import { GroupNode } from '../nodes/GroupNode'
import { Dock } from '../components/Dock'
import { TabBar } from '../components/TabBar'
import { ContextMenu, type MenuItem } from '../components/ContextMenu'
import { CommandPalette, type Command } from '../components/CommandPalette'
import { SettingsPanel } from '../components/SettingsPanel'
import { SourceControlPanel } from '../components/SourceControlPanel'
import { transport } from '../terminal/local-transport'
import { useProjects } from '../state/projects'
import { useSettings } from '../state/settings'
import {
  COLLAPSED_HEIGHT,
  createStickyNode,
  createTerminalNode,
  flowToNodeStates,
  groupSelectedNodes,
  nodeStatesToFlow,
  ungroupNodes,
  type CanvasNode
} from '../state/workspace'

const GRID = 24

export function Canvas() {
  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>([])
  const [dirty, setDirty] = useState(false)
  const [zoomPct, setZoomPct] = useState(100)
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [scOpen, setScOpen] = useState(false)
  const settings = useSettings((s) => s.settings)
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 1 })
  const nodesRef = useRef<CanvasNode[]>(nodes)
  const loadingRef = useRef(false)
  const flowWrapRef = useRef<HTMLDivElement>(null)
  const { setViewport, fitView, zoomIn, zoomOut, screenToFlowPosition, setCenter, getZoom } =
    useReactFlow()

  const activeProjectId = useProjects((s) => s.activeProjectId)
  nodesRef.current = nodes

  const nodeTypes = useMemo(
    () => ({ terminal: TerminalNode, sticky: StickyNode, group: GroupNode }),
    []
  )

  // 1) Load the whole workspace once and hydrate the projects store.
  useEffect(() => {
    let cancelled = false
    void useSettings.getState().hydrate()
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
    setNodes(nodeStatesToFlow(project.nodes))
    viewportRef.current = project.viewport
    setViewport(project.viewport)
    setZoomPct(Math.round(project.viewport.zoom * 100))
    // Let load-induced changes settle before we start tracking edits as dirty.
    const t = setTimeout(() => {
      loadingRef.current = false
    }, 0)
    return () => clearTimeout(t)
  }, [activeProjectId, setNodes, setViewport])

  const markDirty = useCallback(() => {
    if (!loadingRef.current) setDirty(true)
  }, [])

  // ---- persistence helpers ----
  const commitActiveToStore = useCallback(() => {
    const id = useProjects.getState().activeProjectId
    if (id) useProjects.getState().commitCanvas(id, flowToNodeStates(nodesRef.current), viewportRef.current)
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

  // ---- canvas interactions ----
  const handleNodesChange: typeof onNodesChange = useCallback(
    (changes) => {
      onNodesChange(changes)
      if (changes.some((c) => c.type !== 'select')) markDirty()
    },
    [onNodesChange, markDirty]
  )

  /** Flow-space point at the center of the visible canvas (for dock-added nodes). */
  const viewCenter = useCallback(() => {
    const rect = flowWrapRef.current?.getBoundingClientRect()
    if (!rect) return undefined
    return screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  }, [screenToFlowPosition])

  const addTerminal = useCallback(
    (center?: { x: number; y: number }) => {
      const cwd = useProjects.getState().getProject(activeProjectId)?.cwd
      setNodes((ns) => [...ns, createTerminalNode(ns.length, cwd, center ?? viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, activeProjectId, viewCenter]
  )

  const addSticky = useCallback(
    (center?: { x: number; y: number }) => {
      setNodes((ns) => [...ns, createStickyNode(ns.length, center ?? viewCenter())])
      markDirty()
    },
    [setNodes, markDirty, viewCenter]
  )

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
            { label: 'Group selection', onClick: () => groupSelection(ids) },
            { type: 'separator' }
          ] as MenuItem[])
        : []),
      { type: 'colors', onPick: (c) => setNodesColor(ids, c) },
      { type: 'separator' },
      { label: 'Align to grid', onClick: () => alignToGrid(ids) },
      { label: 'Collapse / Expand', onClick: () => toggleCollapseNodes(ids) },
      { type: 'separator' },
      { label: 'Delete', danger: true, onClick: () => deleteNodes(ids) }
    ],
    [groupSelection, setNodesColor, alignToGrid, toggleCollapseNodes, deleteNodes]
  )

  const groupItems = useCallback(
    (groupId: string): MenuItem[] => [
      { type: 'label', label: 'Group' },
      { type: 'colors', onPick: (c) => setNodesColor([groupId], c) },
      { type: 'separator' },
      { label: 'Ungroup', onClick: () => ungroup(groupId) },
      { label: 'Delete (keeps nodes)', danger: true, onClick: () => ungroup(groupId) }
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
          { label: 'New terminal here', onClick: () => addTerminal(at) },
          { label: 'New sticky note here', onClick: () => addSticky(at) },
          { type: 'separator' },
          { label: 'Select all', onClick: selectAll },
          { label: 'Fit view', onClick: () => fitView({ padding: 0.2, duration: 300 }) }
        ]
      })
    },
    [screenToFlowPosition, addTerminal, addSticky, selectAll, fitView]
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
  useEffect(() => {
    markDirty()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    nodes
      .map(
        (n) =>
          `${n.id}:${n.data.title}:${n.data.color}:${n.data.text ?? ''}:${
            n.data.collapsed ? 1 : 0
          }:${((n.data.tags as string[]) ?? []).join(',')}`
      )
      .join('|')
  ])

  const onMove = useCallback(
    (_e: unknown, vp: Viewport) => {
      viewportRef.current = vp
      setZoomPct(Math.round(vp.zoom * 100))
      markDirty()
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

  const addProject = useCallback(() => {
    commitActiveToStore()
    const project = useProjects.getState().addProject()
    useProjects.getState().setActive(project.id)
    void writeDisk()
  }, [commitActiveToStore, writeDisk])

  const addProjectFromFolder = useCallback(async () => {
    const folder = await window.nodeTerminal.dialog.selectFolder()
    if (!folder) return
    const name = folder.split('/').filter(Boolean).pop() || 'Project'
    commitActiveToStore()
    const project = useProjects.getState().addProject(name, folder)
    useProjects.getState().setActive(project.id)
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
      if (store.projects.length <= 1) return
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
      { id: 'new-term', label: 'New terminal', section: 'Create', run: () => addTerminal() },
      { id: 'new-sticky', label: 'New sticky note', run: () => addSticky() },
      { id: 'new-project', label: 'New project', run: () => addProject() },
      { id: 'fit', label: 'Fit view', run: () => fitView({ padding: 0.2, duration: 300 }) },
      { id: 'save', label: 'Save', run: () => void persist() }
    ]
    const store = useProjects.getState()
    store.projects
      .filter((p) => p.id !== store.activeProjectId)
      .forEach((p) =>
        cmds.push({
          id: `proj-${p.id}`,
          label: `Switch to ${p.name}`,
          hint: 'project',
          run: () => switchProject(p.id)
        })
      )
    nodesRef.current
      .filter((n) => n.type !== 'group')
      .forEach((n) =>
        cmds.push({
          id: `node-${n.id}`,
          label: `Go to ${n.data.title}`,
          hint: ((n.data.tags as string[]) ?? []).join(' '),
          run: () => goToNode(n)
        })
      )
    return cmds
  }, [addTerminal, addSticky, addProject, fitView, persist, switchProject, goToNode])

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

      <div className="controls-cluster">
        <button title="Command palette (⌘K)" onClick={() => setPaletteOpen(true)}>
          ⌕
        </button>
        <button title="Source Control" onClick={() => setScOpen(true)}>
          ⎇
        </button>
        <button title="Settings (⌘,)" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </div>

      <div className="flow-wrap" ref={flowWrapRef}>
        <ReactFlow
          nodes={nodes}
          nodeTypes={nodeTypes}
          onNodesChange={handleNodesChange}
          onMove={onMove}
          onPaneContextMenu={onPaneContextMenu}
          onNodeContextMenu={onNodeContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          onNodeDoubleClick={onNodeDoubleClick}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          deleteKeyCode={null}
          selectionOnDrag
          panOnDrag={[1, 2]}
          snapToGrid={settings.snapToGrid}
          snapGrid={[settings.gridSize, settings.gridSize]}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={settings.gridSize || GRID}
            size={1}
            color="#3a3a3a"
          />
          <Controls showInteractive={false} position="bottom-left" />
          <MiniMap
            className="minimap"
            position="bottom-right"
            pannable
            zoomable
            maskColor="rgba(10,12,18,0.6)"
            nodeColor={(n) => (n.data as { color?: string })?.color ?? '#0a84ff'}
            nodeStrokeColor={(n) => (n.data as { color?: string })?.color ?? '#0a84ff'}
          />
        </ReactFlow>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {paletteOpen && (
        <CommandPalette commands={buildCommands()} onClose={() => setPaletteOpen(false)} />
      )}

      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}

      {scOpen && <SourceControlPanel onClose={() => setScOpen(false)} />}

      <Dock
        dirty={dirty}
        zoomPct={zoomPct}
        onAddTerminal={addTerminal}
        onAddSticky={addSticky}
        onSave={persist}
        onFitView={() => fitView({ padding: 0.2, duration: 300 })}
        onZoomIn={() => zoomIn({ duration: 150 })}
        onZoomOut={() => zoomOut({ duration: 150 })}
      />
    </div>
  )
}
