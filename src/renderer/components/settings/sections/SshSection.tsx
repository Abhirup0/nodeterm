import { useEffect, useState } from 'react'
import { useSshServers } from '../../../state/sshServers'
import type { SshServer } from '@shared/ssh'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { Input } from '@renderer/ui/Input'

const ROWS = {
  servers: {
    title: 'Saved SSH servers',
    keywords: ['ssh', 'remote', 'server', 'host', 'connect', 'identity', 'key']
  }
}
const ENTRIES = Object.values(ROWS)

export function SshSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const sshServers = useSshServers((s) => s.servers)
  const [sshDraft, setSshDraft] = useState<SshServer | null>(null)

  useEffect(() => {
    void useSshServers.getState().hydrate()
  }, [])

  const saveDisabled =
    !sshDraft ||
    !sshDraft.label.trim() ||
    !sshDraft.host.trim() ||
    !sshDraft.user.trim()

  return (
    <SettingsSection
      id="ssh"
      title="Remote (SSH)"
      description="Saved SSH servers appear under “New remote”. Opening a remote terminal is a Pro feature."
      isActive={isActive}
      searchEntries={ENTRIES}
    >
      <SearchableRow {...ROWS.servers}>
        <div className="space-y-4">
          {sshServers.map((server) => (
            <div
              key={server.id}
              className="flex items-center justify-between gap-4 rounded-md border border-border p-3"
            >
              <span className="min-w-0 truncate text-sm text-text">
                {server.label} — {server.user}@{server.host}
                {server.port && server.port !== 22 ? `:${server.port}` : ''}
              </span>
              <div className="flex shrink-0 gap-2">
                <Button onClick={() => setSshDraft(server)}>Edit</Button>
                <Button
                  variant="ghost"
                  onClick={() => void useSshServers.getState().remove(server.id)}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}

          {sshDraft ? (
            <div className="space-y-2 rounded-md border border-border p-3">
              <FieldRow
                label="Label"
                control={
                  <Input
                    className="w-56"
                    placeholder="e.g. Prod box"
                    value={sshDraft.label}
                    onChange={(e) => setSshDraft({ ...sshDraft, label: e.target.value })}
                  />
                }
              />
              <FieldRow
                label="Host"
                control={
                  <Input
                    className="w-56"
                    placeholder="e.g. example.com"
                    value={sshDraft.host}
                    onChange={(e) => setSshDraft({ ...sshDraft, host: e.target.value })}
                  />
                }
              />
              <FieldRow
                label="User"
                control={
                  <Input
                    className="w-56"
                    placeholder="e.g. root"
                    value={sshDraft.user}
                    onChange={(e) => setSshDraft({ ...sshDraft, user: e.target.value })}
                  />
                }
              />
              <FieldRow
                label="Port"
                control={
                  <Input
                    className="w-24"
                    type="number"
                    value={sshDraft.port ?? 22}
                    onChange={(e) =>
                      setSshDraft({ ...sshDraft, port: Number(e.target.value) || 22 })
                    }
                  />
                }
              />
              <FieldRow
                label="Identity file"
                description="Optional private key passed with -i."
                control={
                  <div className="flex gap-2">
                    <Input
                      className="w-56"
                      placeholder="~/.ssh/id_ed25519"
                      value={sshDraft.identityFile ?? ''}
                      onChange={(e) =>
                        setSshDraft({ ...sshDraft, identityFile: e.target.value })
                      }
                    />
                    <Button
                      onClick={async () => {
                        const file = await window.nodeTerminal.dialog.selectFile()
                        if (file) setSshDraft({ ...sshDraft, identityFile: file })
                      }}
                    >
                      Choose…
                    </Button>
                  </div>
                }
              />
              <FieldRow
                label="Extra ssh args"
                description="Optional advanced flags, e.g. -o StrictHostKeyChecking=no."
                control={
                  <Input
                    className="w-56"
                    placeholder="(optional)"
                    value={sshDraft.extraArgs ?? ''}
                    onChange={(e) => setSshDraft({ ...sshDraft, extraArgs: e.target.value })}
                  />
                }
              />
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={() => setSshDraft(null)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={saveDisabled}
                  onClick={async () => {
                    await useSshServers.getState().save(sshDraft)
                    setSshDraft(null)
                  }}
                >
                  Save
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() =>
                setSshDraft({
                  id: crypto.randomUUID(),
                  label: '',
                  host: '',
                  user: '',
                  port: 22
                })
              }
            >
              Add server
            </Button>
          )}
        </div>
      </SearchableRow>
    </SettingsSection>
  )
}
