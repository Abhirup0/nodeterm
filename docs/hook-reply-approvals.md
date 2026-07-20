# Hook-reply approvals — deterministic Approve/Deny (v1 contract)

Inspired by claude-island's EventServer: its permission hook holds the HTTP request open and
the UI's Allow/Deny **is the hook's reply** — no keystrokes, no prompt-layout coupling. This
doc adapts that to nodeterm's architecture, where the answerer may be a **phone reaching the
host over SSH** (no route to the desktop's loopback server), so the reply channel is a
**file on the host the agent runs on** — reachable by every answerer we have.

## Why replace send-keys

The phone's quick-approve today types `1`/Escape into tmux. It depends on the permission
prompt being on screen, focused, and numbered the way we assume. Hook-reply is deterministic:
Claude Code applies the decision before ever painting the prompt; on timeout it falls through
to the normal interactive prompt (fail-open, bit-for-bit legacy).

## Mechanism

**Request** — the managed hook script's `PermissionRequest` branch (env-gated like everything
else in `managed-script.ts`), only when `NODETERM_PERM_WAIT_SECS` is set (> 0) in the session
env:
1. Generate `pendingId` = `<nodeId>-<epoch-ms>-$$`.
2. Write the incoming hook JSON to `~/.nodeterm/pending/<pendingId>.json` (mkdir -p, umask 077).
3. POST to the loopback hook server as today (fire-and-forget status flow — this is how the
   mirror/inbox learns `pendingId`).
4. Poll `~/.nodeterm/pending/<pendingId>.answer` every 0.5 s up to `NODETERM_PERM_WAIT_SECS`
   (default injected: 45; hook must stay under Claude's own hook timeout).
5. Answer file appears: read it (`allow` | `deny`), `rm -f` both files, print the decision
   JSON to stdout:
   `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
   (deny adds a short `"message"`). Exit 0.
6. Timeout: `rm -f` the request file, print **nothing**, exit 0 → Claude shows its normal
   prompt; legacy send-keys still works as the fallback.

POSIX sh only, no deps — same constraints as the existing managed script. The wait branch
must be a **no-op** when the env var is absent (user's own terminals, older nodeterm).

**Answerers** (all write the same one-line answer file, atomically `printf > tmp && mv`):
- **Phone (SSH)** — `InboxApproval` writes it over the connection when the approval event
  carries `pendingId`; else falls back to send-keys. Digit `2`/"Always allow" keeps using
  send-keys in v1 (hook `updatedPermissions` is out of scope).
- **Desktop canvas** — the NEEDS-YOU badge gains Approve/Deny buttons (approval events with
  `pendingId` only), routed over IPC to a main-side writer: local project → local fs; SSH
  project → write via the project's ControlMaster. So desktop users are not left staring at
  a held prompt — they get one-click approval the moment the badge pulses.

**Event plumbing** — the hook server's raw `PermissionRequest` payload now carries
`nodeterm_pending_id` (added by the script to its POST body); the mirror's approval
`InboxEvent` gains `pendingId?: string`, riding the mirror (phone) and dropped from the
push-notify POST body (the APNs payload doesn't need it — the phone re-reads the mirror
before acting anyway).

**Env injection** — `buildPtyEnv` adds `NODETERM_PERM_WAIT_SECS=<n>` when the new setting
`hookReplyApprovals` (default **on**) is enabled AND the agent is claude (the only CLI whose
PermissionRequest hook decision contract we've verified). Setting lives beside the mobile-push
settings; off ⇒ env absent ⇒ script branch inert ⇒ exact legacy behavior.

**Cleanup** — the hook server sweeps `~/.nodeterm/pending/` for files older than 10 min on
boot and hourly (orphans from killed sessions). The phone/desktop never create answer files
for pendingIds they didn't read from a live approval event, and re-check the event is still
unresolved before writing.

## Out of scope (v1)

- Questions (AskUserQuestion) — a hook cannot inject an answer value; digits remain.
- "Always allow" via hook `updatedPermissions`.
- codex/gemini permission hooks (unverified decision contracts).
- The desktop notch/HUD overlay (separate feature).
