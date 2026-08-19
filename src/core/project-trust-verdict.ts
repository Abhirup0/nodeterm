import {
  projectTrustContent,
  type ProjectSettingsDoc,
  type ProjectTrustFamily
} from '../shared/project-settings'
import type { ProjectSetupTargetInfo } from './project-setup-runner-local'
import { hashTrustContent, localTrustKey, sshTrustKey, type ProjectTrustStore } from './project-trust-store'

/**
 * The ONE trust verdict a consumer of project settings asks for, shared by every consumer so the
 * hash rule cannot fork.
 *
 * Two callers today: `project-settings:launch-info` (the renderer's pre-launch read,
 * `project-launch-info-handlers.ts`) and `makeProjectSpawnOverrides` (the spawn's own read,
 * `project-spawn-overrides.ts`). They MUST agree — a renderer told "trusted" while the spawn
 * silently drops the same value, or the reverse, is a gate that reports one thing and enforces
 * another. Keeping the rule here is what makes that impossible rather than merely unlikely.
 *
 * The rule itself is `ProjectSetupService.run`'s, aimed at a family this process never executes:
 *  - the hash covers the SHARED document alone — never the merged/effective one, or a local
 *    override could launder a shared change past the hash,
 *  - a family with NO shared executable content (`projectTrustContent` → null) is trusted with no
 *    prompt: there is nothing hostile to gate,
 *  - trust is keyed by LOCATION, never by project id (ids come out of an attacker-controlled
 *    `project.json` — hostile-project-json).
 */

/** The LOCATION key for a project's own index entry. A cwd-less inline canvas falls to
 *  `localTrustKey('')` — inert by construction: such a project has no shared document, so every
 *  family's `projectTrustContent` returns null before this key is ever consulted. */
export function projectTrustKeyFor(info: ProjectSetupTargetInfo | null | undefined): string {
  return info?.ssh
    ? sshTrustKey({ server: info.ssh.server, remoteCwd: info.ssh.remoteCwd })
    : localTrustKey(info?.cwd ?? '')
}

/**
 * Is this family's SHARED content trusted at `key` right now? `true` also when the family has no
 * shared executable content at all (nothing to gate). A trust store that throws is NOT trusted —
 * fail closed on the grant, never on the spawn (callers keep going without the shared value).
 */
export async function projectFamilyTrusted(
  trust: Pick<ProjectTrustStore, 'isTrusted'>,
  key: string,
  family: ProjectTrustFamily,
  sharedDoc: ProjectSettingsDoc
): Promise<boolean> {
  const content = projectTrustContent(family, sharedDoc)
  if (content === null) return true
  try {
    return await trust.isTrusted(key, family, hashTrustContent(content))
  } catch {
    return false
  }
}
