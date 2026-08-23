/** Which node ⌘⇧F / the "Focus node" palette entry acts on (issue #78): the selected terminal
 *  node. Only terminals — focus mode reparents the node's xterm host, which is meaningless for
 *  stickies/groups/editors. With several selected, the first wins (a deliberate, boring rule —
 *  matching how single-node actions elsewhere resolve multi-selection). */
export function focusTargetId(
  nodes: readonly { id: string; type?: string; selected?: boolean }[]
): string | null {
  return nodes.find((n) => n.selected && n.type === 'terminal')?.id ?? null
}
