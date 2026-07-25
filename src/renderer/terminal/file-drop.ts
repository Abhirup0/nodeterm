// Shared terminal file-drop logic — used by both the canvas TerminalNode and the kanban card
// modal's co-attach terminal (ModalTerminal), so a file dropped onto either pastes the same way.

/** Backslash-escape shell-special characters, like a native terminal does on file drop. */
export function escapeDroppedPath(p: string): string {
  return p.replace(/([ \t"'`\\()&;|<>$!*?[\]{}#~])/g, '\\$1')
}

/**
 * Resolve dropped files to terminal-pasteable paths. For an SSH-project terminal a local path is
 * useless on the host, so each file is uploaded over the project's ControlMaster and its REMOTE
 * absolute path is returned; for a local terminal the local path is used. Fail-open: files that
 * can't be resolved/uploaded are dropped from the result (never throws).
 */
export async function droppedPaths(
  files: File[],
  opts: { sshRemoteTmux: boolean; projectId: string }
): Promise<string[]> {
  if (opts.sshRemoteTmux) {
    const uploaded = await Promise.all(
      files.map((f) => {
        const lp = window.nodeTerminal.getPathForFile(f)
        return lp
          ? window.nodeTerminal.sshProject.uploadFile(opts.projectId, lp, f.name).catch(() => null)
          : Promise.resolve(null)
      })
    )
    return uploaded.filter((p): p is string => !!p).map(escapeDroppedPath)
  }
  return files
    .map((f) => window.nodeTerminal.getPathForFile(f))
    .filter((p): p is string => !!p)
    .map(escapeDroppedPath)
}
