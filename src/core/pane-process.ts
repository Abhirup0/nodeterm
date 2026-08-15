import { isShellCommand } from '../shared/agents/pane'

export interface PaneProcess {
  panePid: number
  command: string
}

/** Parse the deliberately tiny tmux format used before terminating a pane's foreground agent. */
export function parsePaneProcess(value: string): PaneProcess | null {
  const line = value.trim()
  const split = line.indexOf('|')
  if (split <= 0) return null
  const panePid = Number(line.slice(0, split))
  const command = line.slice(split + 1).trim()
  if (!Number.isSafeInteger(panePid) || panePid <= 0 || !command) return null
  return { panePid, command }
}

/**
 * Validate `ps -o tpgid=` against the tmux pane we just observed. The pane PID is its login
 * shell/process-group leader; killing that group would destroy the shell rather than only the
 * foreground agent, so it is always refused. A shell reported directly by tmux is refused too.
 */
export function foregroundProcessGroup(
  pane: PaneProcess,
  value: string
): number | null {
  if (isShellCommand(pane.command)) return null
  const processGroup = Number(value.trim())
  if (
    !Number.isSafeInteger(processGroup) ||
    processGroup <= 0 ||
    processGroup === pane.panePid
  ) {
    return null
  }
  return processGroup
}
