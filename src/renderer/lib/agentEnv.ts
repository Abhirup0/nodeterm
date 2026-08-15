// The renderer-side environment for `${env:VAR}` expansion in custom-agent launch commands.
//
// One snapshot, fetched once from the desktop main process and cached: every consumer — the
// Settings command preview, fresh node creation (`workspace.ts createAgentNode`), and the
// cold-restore / variant-reopen resume paths in `TerminalNode.tsx` — expands against THIS object,
// and the preview uses the same assembler (`shared/agents/launch.ts`). Same code + same env ⇒ the
// preview cannot drift from the typed launch line, which is the guarantee the Settings card makes.
//
// On the browser (Server Edition) and over relay the bridge resolves `{}` by design: a host env
// dump must never cross to a peer (the PR #195 credential-leak class at the RPC layer). There,
// every `${env:…}` reference reports as missing and the launch paths refuse rather than type a
// mangled command — and the preview shows the same refusal, so the parity holds in the degraded
// case too.
//
// The snapshot is static by nature: a desktop app's `process.env` is fixed at app launch, so
// there is nothing to re-poll. `refreshAgentEnv()` exists for boot and for tests.

let cached: Record<string, string> = {}
let fetched = false

/** The cached env snapshot. `{}` until `refreshAgentEnv()` resolves (and forever on browser/relay). */
export function agentEnvSnapshot(): Record<string, string> {
  return cached
}

/** Fetch the snapshot once at renderer boot. Safe to call again (tests, HMR); never rejects. */
export async function refreshAgentEnv(): Promise<void> {
  try {
    cached = await window.nodeTerminal.agent.envSnapshot()
  } catch {
    cached = {}
  }
  fetched = true
}

/** Has the boot fetch settled? (Distinguishes "empty because browser" from "not asked yet".) */
export function agentEnvReady(): boolean {
  return fetched
}

/** Test seam. */
export function setAgentEnvForTests(env: Record<string, string>): void {
  cached = env
  fetched = true
}
