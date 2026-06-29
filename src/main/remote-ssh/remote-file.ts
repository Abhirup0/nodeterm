// Reads remote files over the project's existing ControlMaster (`ssh <childArgs> 'tail …'`).
// Pure builders + an injected-runner class so the read logic is electron-free and unit-testable;
// the actual ssh spawn is injected by the caller (Tasks 2/3 wire it to the project's runner).
import { childArgs } from './control-master'
import { posixQuote, type SshConnection } from '../../shared/ssh'

export interface RemoteFileRef {
  conn: SshConnection
  controlPath: string
  path: string
}

export function tailFromOffsetArgs(conn: SshConnection, controlPath: string, path: string, offset: number): string[] {
  return childArgs(conn, controlPath, `tail -c +${offset + 1} ${posixQuote(path)}`)
}
export function tailLastBytesArgs(conn: SshConnection, controlPath: string, path: string, bytes: number): string[] {
  return childArgs(conn, controlPath, `tail -c ${bytes} ${posixQuote(path)}`)
}

/** Reads a remote file over the project's ControlMaster. Fail-open: errors → empty. */
export class RemoteFile {
  constructor(private run: (args: string[]) => Promise<{ code: number; stdout: string }>) {}

  async readFrom(ref: RemoteFileRef, offset: number): Promise<{ text: string; newOffset: number }> {
    try {
      const { code, stdout } = await this.run(tailFromOffsetArgs(ref.conn, ref.controlPath, ref.path, offset))
      if (code !== 0) return { text: '', newOffset: offset }
      return { text: stdout, newOffset: offset + Buffer.byteLength(stdout) }
    } catch {
      return { text: '', newOffset: offset }
    }
  }

  async readTail(ref: RemoteFileRef, bytes: number): Promise<string> {
    try {
      const { code, stdout } = await this.run(tailLastBytesArgs(ref.conn, ref.controlPath, ref.path, bytes))
      return code === 0 ? stdout : ''
    } catch {
      return ''
    }
  }
}
