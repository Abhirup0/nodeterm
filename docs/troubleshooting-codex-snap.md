# Codex agent status doesn't work (RUNNING/NEEDS-YOU never light up)

**Symptom.** A Codex session shows no live status on the canvas or on the phone — no
"RUNNING" badge, no walking-pet mascot, no NEEDS-YOU, no completion notification. Claude and
Gemini on the **same host** report fine, and Codex works when run from a **local** desktop
session. It only breaks on a host where Codex was installed as a **snap** (Ubuntu's
`snap install codex`, `/snap/bin/codex`).

**Root cause — snap confinement, not a nodeterm bug.** nodeterm installs Codex's managed
hooks correctly: `~/.codex/hooks.json` (six events → the managed `codex.sh`) plus the matching
`[hooks.state."…"] trusted_hash = "sha256:…"` trust entries in `~/.codex/config.toml`. Verified
in the field: the files are present, the script is executable, the trust hashes match. But the
**snap** build of Codex never reads them, for two stacked reasons:

1. **`$HOME` / `CODEX_HOME` remap.** A snap runs with `HOME` (and therefore `CODEX_HOME`)
   pointed at its own sandbox dir — e.g. `/root/snap/codex/<rev>/` — so `snap` Codex looks for
   its config under `~/snap/codex/<rev>/.codex/`, **not** the standard `~/.codex/` where
   nodeterm (and every other tool) writes. The hooks are installed in a directory the snap
   Codex simply never consults.
2. **Exec confinement.** Even if the hook config were found, the hook command runs
   `~/.nodeterm/agent-hooks/codex.sh`. A snap's AppArmor profile only allows its own
   `$HOME` sandbox; a script under `/root/.nodeterm/…` (outside the snap home) can't be
   executed. So the hook chain is structurally unreachable under snap confinement.

Claude/Gemini are unaffected because they aren't distributed as snaps here.

## Fix — install Codex outside snap confinement

```sh
snap remove codex
npm i -g @openai/codex        # now CODEX_HOME resolves to ~/.codex (no remap)
codex login                   # the fresh ~/.codex has no auth.json yet — sign in once
```

Ensure the npm binary wins on `PATH` (it normally does — `/usr/bin` before `/snap/bin`):
`command -v codex` should print `/usr/bin/codex`, and `codex --version` a recent (≥ 0.145)
build. Then reconnect the SSH project (or restart the headless Server Edition) so nodeterm
reinstalls the hooks against the now-visible `~/.codex`, and open a fresh Codex node —
RUNNING/NEEDS-YOU and the walking pet should light up.

### Notes
- Alternatives that also work: run Codex as a non-snap install under any user whose `~/.codex`
  is the real path, or point `CODEX_HOME` at a directory nodeterm can install into. The npm
  install is the simplest.
- The managed hook/trust install itself is correct and version-checked (`codex-trust.ts`
  golden-locks the hashes). If a **much newer** Codex ever changes its hook-hash serialization,
  the trust would stop matching — that's a separate, tracked concern, not this snap issue.
- Codex ≥ 0.145 still uses `config.toml` trust hashes (the `--dangerously-bypass-hook-trust`
  flag confirms the trust gate is intact).
