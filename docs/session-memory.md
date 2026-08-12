# Session memory: the RAM pill and the per-session panel

A bottom-left **RAM pill** beside the usage pill, and the **session-memory panel** it opens: how
much memory the machine the *active project* runs on is using, and which `nt-*` tmux session is
holding it.

> Design spec: `docs/superpowers/specs/2026-08-10-session-memory-panel-design.md`.
> The condensed rules live in `CLAUDE.md` ("Session memory"); this document carries the
> measurements, the reasoning that is too long for that file, and **§10, the device checklist** for
> everything that could not be verified on the headless Linux box this was built on.

Files:

| Layer | File |
|---|---|
| Local read + pure assembly | `src/core/session-memory.ts` |
| The SSH host's leg (generated `sh`) | `src/core/session-memory-remote.ts` |
| RPC + routing (booted by BOTH shells) | `src/core/session-memory-service.ts` |
| Renderer store (two cadences) | `src/renderer/state/sessionMemory.ts` |
| Rows → titles / projects / orphans | `src/renderer/lib/sessionMemoryRows.ts` |
| Where a kill has to land | `src/renderer/lib/sessionKill.ts` |
| Pill + panel | `src/renderer/components/SystemResourcePill.tsx`, `SessionMemoryPanel.tsx` |

---

## 1. What was measured, and what it means

The feature exists because a user reported *"Claude terminals are killing my memory, each one takes
2 GB"*. Measured on the production host (64 GB, 95 live `claude` processes):

| What | Measurement |
|---|---|
| `claude` process alone | avg **335 MB**, peak **1159 MB** |
| 95 `claude` processes | **31.1 GB** |
| MCP children per session | +30–200 MB (playwright-mcp + Chrome ≈ 200 MB alone) |
| One "Claude terminal" tree | **440 MB – 1.2 GB** |
| nodeterm-server (per user) | 49–82 MB |
| tmux client (per attached session) | 5. **DONE 2026-08-12** — macOS `ps` path measured. `ps rss` is NOT the right number there:
    footprint/rss is ~1 for active claude processes (one read 0.73x) but **1.84-2.20x for idle**
    ones, the population this panel describes. The panel now reads phys_footprint via `top`.
    Still open: confirm the panel's per-row totals against Activity Monitor's Memory column
    for the same pids, on the build that contains this change.
 6. ~~macOS: check `parseVmStat` against Activity Monitor.~~ **DONE 2026-08-12** — 19.1 GB vs
    AM's 19.00 GB of parts on a 24 GB machine (was 23.9/24.0 before the fix). Still open on
    macOS: give the memory-PRESSURE monitor a real signal (`kern.memorystatus_vm_pressure_level`)
    rather than a byte watermark — the same capture showed 82% used with AM's pressure graph GREEN.
 7. Open an SSH project: the panel must list THAT host's sessions and no local ones, and its header
    scope + the pill's title must read `user@host`.
 8. Open an SSH project BEFORE its ControlMaster is up. The pill must end on a NUMBER, not a
    permanent pulse — this is the only place the connection-up re-read can be observed.
 9. A non-Linux SSH host (no /proc/meminfo): the pill must PULSE, never show "0 GB".
10. Kill the master mid-sweep (`ssh -O exit`) and press ⟳: "Could not measure", never an empty list.
10b. BREAK TMUX ON THE HOST while sessions are running (rename the binary, or `chmod 000` the socket
    dir) and press ⟳: the panel must say "Could not measure", NOT "No sessions are running here.".
    This is what the per-socket `##SOCKRC` fence buys, and the only place it can be seen for real.
11. Watch ⟳ during a slow remote sweep: the button must be disabled and spinning (loading is
    asserted nowhere).

Layout and theming (argued from CSS only)
12. Default window and ~900 px wide: the cluster at left:60px clears the React Flow controls and the
    canvas-lock button.
13. A machine with NO agent usage — UsageIndicator renders null, so the RAM pill must sit alone at
    left:60px, un-clipped.
14. Kanban board open: the pill is visible AND clickable over the board.
15. Sessions sidebar open: the collapsed pill passes UNDER the sidebar exactly as the usage pill
    does.
16. Usage popover open beside the RAM pill: no overlap, pill still clickable.
17. Both themes: hover (light is why the ink overlay exists) and the icon's colour steps at ~75% and
    ~90% used.
18. fitView / goToNode must no longer tuck nodes under the pill.

Rows, travel and the panel itself
19. A `claude` node with 2 MCP servers must read `+3 child processes`, not +2: `pane_pid` is the
    pane's SHELL, so the count includes the agent CLI itself. This is the ONLY item that can
    falsify the "reports 3" claim made twice above; everything else about the sub-line is arithmetic.
20. Travel to a row whose node lives in a CLOSED project: the tab must REOPEN and the camera land on
    the node. This is the likeliest thing on the list to be wrong — the load and the focus happen in
    the same tick, and `travelToNode` (not `focusNodeById`) is what handles it.
21. A LOCAL orphan row (`tmux -L node-terminal new-session -d -s nt-fake-1`) renders with a hollow
    dot and a "no node" chip, and its title is inert — clicking it must do nothing at all.
22. The panel STAYS OPEN through a kill: the ConfirmDialog is a portal outside the pill's container,
    and answering it must not dismiss the list the user is working through. Clicking anywhere else
    on the canvas must still close the panel.
23. The confirm on a row that HAS a node must say the node is removed too, and it must actually be
    gone from the canvas afterwards — the panel's purpose invites a user who only wanted the RAM.

Cadence and the other surfaces
24. Local project, panel closed: the pill's number moves after 30 s.
25. Local project: opening the panel triggers a sweep; closing and reopening triggers another; the
    pill alone never does (watch for `ps`/`/proc` activity, or an ssh exec on an SSH scope).
26. Server Edition in a browser: a local project's panel is full; an SSH project's panel says
    "Could not measure", with no local rows attributed to the host.
27. Relay tab: the panel says session memory is not available there, and offers no ⟳.
```
