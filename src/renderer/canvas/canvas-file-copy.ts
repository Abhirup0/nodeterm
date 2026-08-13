import type { CanvasNode } from '../state/workspace'

const LOCAL_FILE_NODE_TYPES = new Set(['editor', 'video', 'web'])

/** Paths represented by the selected local file-backed nodes, in canvas order and without dupes. */
export function selectedLocalFilePaths(nodes: CanvasNode[]): string[] {
  const seen = new Set<string>()
  const paths: string[] = []
  for (const node of nodes) {
    const path = node.data.filePath
    if (
      !node.selected ||
      !LOCAL_FILE_NODE_TYPES.has(node.type) ||
      typeof path !== 'string' ||
      !path ||
      node.data.sshFs ||
      node.data.fileMissing ||
      seen.has(path)
    ) {
      continue
    }
    seen.add(path)
    paths.push(path)
  }
  return paths
}
