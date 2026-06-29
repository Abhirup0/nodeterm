import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useSshServers } from '../state/sshServers'
import type { SshServer } from '@shared/ssh'

interface SshProjectDialogProps {
  /** Create the SSH project (Canvas commits the active canvas, adds + switches to it). */
  onCreate: (input: { server: SshServer; remoteCwd: string; label: string }) => void
  /** Open Settings → SSH so the user can add/manage saved servers. */
  onManage: () => void
  onClose: () => void
}

type Step = 'pick' | 'connecting' | 'browse' | 'error'

/** Shared style for a clickable row (server / remote folder). Hover/focus left to defaults. */
const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  gap: 2,
  width: '100%',
  textAlign: 'left',
  padding: '8px 11px',
  background: 'var(--panel-header)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 13,
  cursor: 'pointer'
}

/** Basename of an absolute remote path (for the project label). */
function baseName(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const seg = trimmed.split('/').filter(Boolean).pop()
  return seg || trimmed || '~'
}

/** Parent directory of an absolute remote path; stops at '/'. */
function parentDir(p: string): string {
  const trimmed = p.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  if (idx <= 0) return '/'
  return trimmed.slice(0, idx)
}

/**
 * "Connect over SSH…" project creation flow: pick a saved server, open its ControlMaster,
 * browse the remote filesystem, and create an SSH project rooted at the chosen folder.
 *
 * The browse uses a throwaway connection (a temporary project id) so the dialog never needs a
 * project id before one exists; Canvas establishes the project's real master on switch. The
 * temporary master is torn down on create/cancel.
 */
export function SshProjectDialog({ onCreate, onManage, onClose }: SshProjectDialogProps) {
  const servers = useSshServers((s) => s.servers)
  const [step, setStep] = useState<Step>('pick')
  const [server, setServer] = useState<SshServer | null>(null)
  const [path, setPath] = useState('~')
  const [dirs, setDirs] = useState<string[]>([])
  const [error, setError] = useState('')
  // Inline "new folder" creation in the browse step.
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [mkdirErr, setMkdirErr] = useState('')
  // Stable id for the temporary browse master, generated once.
  const browseIdRef = useRef(`ssh-browse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  const connectedRef = useRef(false)

  // Tear down the temporary browse master (best-effort) once it's no longer needed.
  const disconnectBrowse = useCallback(() => {
    if (connectedRef.current) {
      connectedRef.current = false
      void window.nodeTerminal.sshProject.disconnect(browseIdRef.current)
    }
  }, [])

  const close = useCallback(() => {
    disconnectBrowse()
    onClose()
  }, [disconnectBrowse, onClose])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // Disconnect the browse master if the dialog unmounts without an explicit close.
  useEffect(() => () => disconnectBrowse(), [disconnectBrowse])

  const list = useCallback(async (dir: string) => {
    const res = await window.nodeTerminal.sshProject.listDir(browseIdRef.current, dir)
    setPath(res.path)
    setDirs(res.dirs)
  }, [])

  // Create a folder under the current path on the remote, then navigate into it.
  const createFolder = useCallback(async () => {
    const name = newName.trim()
    if (!name) return
    setMkdirErr('')
    const full = `${path.replace(/\/+$/, '')}/${name}`
    const ok = await window.nodeTerminal.sshProject.mkdir(browseIdRef.current, full)
    if (!ok) {
      setMkdirErr('Could not create the folder.')
      return
    }
    setCreating(false)
    setNewName('')
    await list(full)
  }, [newName, path, list])

  const connect = useCallback(
    async (srv: SshServer) => {
      setServer(srv)
      setError('')
      setStep('connecting')
      try {
        await window.nodeTerminal.sshProject.connect(browseIdRef.current, srv)
        connectedRef.current = true
        await list('~')
        setStep('browse')
      } catch (err) {
        setError((err as Error)?.message || 'Could not connect to the server.')
        setStep('error')
      }
    },
    [list]
  )

  const useThisFolder = useCallback(() => {
    if (!server) return
    disconnectBrowse()
    onCreate({ server, remoteCwd: path, label: `${baseName(path)} · ${server.label}` })
    onClose()
  }, [server, path, disconnectBrowse, onCreate, onClose])

  const body = (() => {
    if (step === 'pick') {
      return (
        <>
          <p className="confirm__msg" style={{ fontWeight: 600 }}>
            Connect over SSH
          </p>
          <p className="confirm__msg">Pick a saved server to host this project's terminals.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 14px' }}>
            {servers.length === 0 ? (
              <p className="confirm__msg" style={{ opacity: 0.7 }}>
                No saved servers yet.
              </p>
            ) : (
              servers.map((s) => (
                <button
                  key={s.id}
                  style={ROW_STYLE}
                  title={`${s.user}@${s.host}`}
                  onClick={() => void connect(s)}
                >
                  <span style={{ fontWeight: 600 }}>{s.label}</span>
                  <span style={{ opacity: 0.6, fontSize: 12 }}>
                    {s.user}@{s.host}
                  </span>
                </button>
              ))
            )}
          </div>
          <div className="confirm__actions">
            <button className="confirm__btn" onClick={close}>
              Cancel
            </button>
            <button
              className="confirm__btn primary"
              onClick={() => {
                onManage()
                close()
              }}
            >
              Add server…
            </button>
          </div>
        </>
      )
    }
    if (step === 'connecting') {
      return (
        <>
          <p className="confirm__msg" style={{ fontWeight: 600 }}>
            Connecting to {server?.label}…
          </p>
          <p className="confirm__msg" style={{ opacity: 0.7 }}>
            Establishing the SSH connection.
          </p>
          <div className="confirm__actions">
            <button className="confirm__btn" onClick={close}>
              Cancel
            </button>
          </div>
        </>
      )
    }
    if (step === 'error') {
      return (
        <>
          <p className="confirm__msg" style={{ fontWeight: 600 }}>
            Connection failed
          </p>
          <p className="confirm__msg" style={{ opacity: 0.8 }}>
            {error}
          </p>
          <div className="confirm__actions">
            <button className="confirm__btn" onClick={close}>
              Close
            </button>
            <button
              className="confirm__btn primary"
              onClick={() => server && void connect(server)}
            >
              Retry
            </button>
          </div>
        </>
      )
    }
    // browse
    const atRoot = path === '/'
    return (
      <>
        <p className="confirm__msg" style={{ fontWeight: 600 }}>
          Choose a folder on {server?.label}
        </p>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            margin: '4px 0 8px',
            fontSize: 12,
            color: 'var(--muted)'
          }}
        >
          <button
            className="confirm__btn"
            style={{ padding: '3px 9px' }}
            disabled={atRoot}
            onClick={() => void list(parentDir(path))}
          >
            ↑ Up
          </button>
          <button
            className="confirm__btn"
            style={{ padding: '3px 9px' }}
            onClick={() => {
              setMkdirErr('')
              setNewName('')
              setCreating(true)
            }}
          >
            ＋ New folder
          </button>
          <span
            title={path}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {path}
          </span>
        </div>
        {creating && (
          <div style={{ display: 'flex', gap: 8, margin: '0 0 8px' }}>
            <input
              autoFocus
              value={newName}
              placeholder="Folder name"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFolder()
                else if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                  setMkdirErr('')
                }
              }}
              style={{ flex: 1, minWidth: 0 }}
            />
            <button className="confirm__btn primary" style={{ padding: '3px 9px' }} onClick={() => void createFolder()}>
              Create
            </button>
            <button
              className="confirm__btn"
              style={{ padding: '3px 9px' }}
              onClick={() => {
                setCreating(false)
                setNewName('')
                setMkdirErr('')
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {mkdirErr && (
          <p className="confirm__msg" style={{ color: 'var(--danger, #e5534b)', margin: '0 0 8px', fontSize: 12 }}>
            {mkdirErr}
          </p>
        )}
        <div
          style={{
            maxHeight: 240,
            overflowY: 'auto',
            border: '1px solid var(--border)',
            borderRadius: 8,
            margin: '0 0 14px'
          }}
        >
          {dirs.length === 0 ? (
            <p className="confirm__msg" style={{ opacity: 0.6, padding: '10px 12px' }}>
              No sub-folders here.
            </p>
          ) : (
            dirs.map((d) => (
              <button
                key={d}
                style={{ ...ROW_STYLE, border: 'none', borderRadius: 0, background: 'transparent' }}
                onClick={() => void list(`${path.replace(/\/+$/, '')}/${d}`)}
              >
                <span>📁 {d}</span>
              </button>
            ))
          )}
        </div>
        <div className="confirm__actions">
          <button className="confirm__btn" onClick={close}>
            Cancel
          </button>
          <button className="confirm__btn primary" onClick={useThisFolder}>
            Use this folder
          </button>
        </div>
      </>
    )
  })()

  return createPortal(
    <div className="confirm-overlay" onClick={close}>
      <div className="confirm" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        {body}
      </div>
    </div>,
    document.body
  )
}
