# Browser control (S8) — device acceptance gate

**This is the gate the `browser` verb does not ship "verified" without.** Everything the verb does
that matters — attaching a debugger to a real `<webview>`, reading a real DOM, driving pointer/keyboard
input, capturing a real image, reading real cookies — happens against Electron's CDP, which the
(node-environment) test suite cannot exercise. Global Constraint 8 forbids proving that surface with a
hand-rolled CDP stub, because this repo has twice shipped a real defect through exactly such a test.
So the pure logic (the gate order, the parser, the allowlist, the ledger, the cookie-write
unreachability guard) is green in CI, and **the parts that touch a real page are unverified until the
boxes below are ticked on a real Electron build**.

There is no Electron `<webview>` harness in this repo today (only server/ssh e2e suites). Building one
is the honest way to automate this list; until it exists, this is a human/device run. Tick a box only
when the stated observation is what actually happened; note anything else inline. Run it on a desktop
build (Electron `42.8.1`, `package.json:142`), not the Server Edition — the Server Edition has no
browser control at all (`control-unsupported-on-this-edition`) and nothing here applies there.

Feature switch: **Settings → Agents → "Let agents drive browser nodes they open"** (per project, off
by default). The stop surface: **Settings → Agents → Browser control**, and the on-node chip.

---

## 0. Setup

- [ ] **0.1** A desktop build off this branch, a project you can toggle, and one agent node whose
      identity is **verified** (a real Claude/Codex node with a materialised token, not a phone or a
      pre-token session). DevTools open on the renderer, and a way to watch the CDP traffic (a spy on
      `debugger.sendCommand`, or the audit board-log the run writes) — several boxes assert on
      commands that were and were NOT emitted.
- [ ] **0.2** A local fixture page you control, served over `http(s)`, containing: a normal link and
      button, a text input, a `type="password"` input, an `<input type="hidden">`, an element with
      `aria-hidden="true"`, and an element with `display:none`. Section 2's exclusion checks need all
      six on one page.

## 1. The gate — one owner drives one real page, end to end

Run this as **one continuous session**, not six isolated checks: the chain has links that have each
been believed-and-wrong before, and a suite of isolated passes would go green while the chain was
broken (that is how S8 once shipped an "ownership" model over an unauthenticated socket).

- [ ] **1.1 Switch OFF ⇒ refused, and NO debugger attaches.** With the project switch off, the
      verified agent runs `browser --node <id> --read title`. It is refused with the exact sentence
      *"Browser control is off for this project. The user can turn it on in the project's Agents
      settings; you cannot."* — and the debugger attach count stays **zero** (the refusal is decided
      before any attach).
- [ ] **1.2 Switch ON, notice acknowledged, verified caller opens a browser node.** Turn the switch
      on (acknowledge the one-time clone notice if this project was never personally switched on). The
      verified agent's `open-browser` creates a node on the session jar
      **`persist:nt-agent-browser-<projectId>`**, the in-memory ledger owns it, and the ownership
      rope is drawn on the canvas.
- [ ] **1.3 Drive it.** In order: `--nav <local fixture>`, `--read map`, `--click @n` (a ref from the
      map), `--type "..." --into @m`, `--read text`. Each succeeds. The **driving chip is lit
      throughout**, and stays lit for `INDICATOR_LINGER_MS` (**5 s**, `src/shared/browser-indicator.ts`)
      after the last action.
- [ ] **1.4 A different agent cannot drive it, and cannot tell it exists.** From a *second* agent node,
      call `browser --node <the browser node id>`. The refusal is **byte-identical** to
      `no drivable browser node "<id>"` for a node id that does not exist at all — no enumeration
      oracle (`noDrivableNodeMessage`, `src/main/browser-drive.ts`).
- [ ] **1.5 A user-opened node, and a restored node, are undrivable.** A browser node the **user**
      opened (default session, no partition) is undrivable by any agent; so is one restored from
      `project.json` after a reload. Both answer the same non-enumerating refusal — ownership is the
      in-memory ledger, never `ropes` from the shared file.
- [ ] **1.6 Four bad identities, one refusal each.** Repeat 1.3's first call with a `legacy` token, a
      `forged` token, an invented `kid`, and with `settings.hookIdentityStrict: false`. **All four**
      answer `Browser control refused.` — `browser` is verified-only in `STRICT_CONTROL_VERBS`,
      checked before the override branch and the dated window, so none of these softens it.
- [ ] **1.7 Discard has its own message, and a live lease suppresses it.** Hide the driven node past
      `BROWSER_DISCARD_MS` (**5 min**, `src/renderer/nodes/browser-discard-policy.ts`) **while a lease
      is live**: it is NOT discarded. After the lease ends, the next retry discards it. A call against
      the discarded node then names the **discard** ("released to save memory … bring it on screen or
      open a new one"), never a permissions verdict.
- [ ] **1.8 Stop from the chip mid-`--wait` cancels the in-flight verb.** Start a `--wait`, hit **Stop**
      on the chip. The in-flight verb is cancelled, and the next call names the **human act**
      (`browser-<n>: the user stopped agent control of this node`), not a retryable null — and stays
      stopped until a fresh verified claim.
- [ ] **1.9 Cookies: trace BEFORE read, and a failed trace means NO read.** `browser --node <id>
      --cookies github.com` writes a board-log line (naming the owner, the domain, the node) **before**
      it replies with cookies. Then force the board-log append to fail and repeat: **no cookie is
      returned** (fail-closed).
- [ ] **1.10 CDP spy over the whole run.** With a spy on every command the whole session emitted:
      **zero** carry an `expression` field, **zero** are `Runtime.evaluate`, **zero** are in the
      `Debugger.*` domain. Every command that was emitted passes `checkCdpCommand`
      (`src/main/browser-cdp-allowlist.ts`, default-deny).

## 2. The owed device verifications (accumulated from PRs 7–9 reviews)

These are the specific things earlier PRs closed at the SOURCE or mitigated, but whose real-DOM /
real-capture behaviour was never exercised on a webview. **The feature is not "verified" until each
runs on a real Electron webview.**

- [ ] **2.1 In-page EXCLUSION from `--read` (from PR 7 / #308).** On the 0.2 fixture, run `--read map`,
      `--read text` and `--read links`. **None** of the output includes the `type="password"` field's
      value, the `<input type="hidden">`, the `aria-hidden="true"` element, or the `display:none`
      element. PR 7's tests ran `environment:'node'` with pre-filtered fakes, so the reader scripts
      never touched a real DOM; the catastrophic path (a credential *value*) is closed at source, but
      element-level exclusion is unexercised until this box is ticked.
- [ ] **2.2 `--scroll` sign, and Enter/Tab submission (from PR 8 / #309).** `--scroll down` and
      `--scroll -200` move the page in the expected directions (sign correct); `--press Enter` submits
      a focused form and `--press Tab` moves focus. Device-unverified in PR 8 (mitigated only by
      read-back) — confirm on a real webview.
- [ ] **2.3 `--screenshot` captures a real image, jailed to the project dir (from PR 9 / #310).**
      `--screenshot out.png` and `--screenshot out.png --full true` each write a **real image** file,
      and the write is **jailed to the project directory** (a path escaping it is refused). PR 9 had no
      display, so capture was device-unverified (only the measured-dimensions reply mitigated it).
- [ ] **2.4 The set-cookie guard, kept forever (from PR 9 / #310, design note).** `Network.setCookie`
      is *admitted* by `checkCdpCommand` (owner decision 5, listed in the allowlist) but is
      **unreachable**: no verb emits it. Its unreachability rests on the reachability guard, not on the
      gate — `src/main/browser-cookie-write-guard.test.ts` and the reachability guard in
      `browser-cdp-allowlist.test.ts` (PR 9 Task 9.4) must stay green forever. If either is ever
      removed, a cookie-write verb has become reachable: treat that as a release blocker. On the device,
      confirm no `Network.setCookie` (or any `*.setCookie*`) ever appears in the 1.10 spy.

## 3. Out of scope for this gate (tracked separately)

- The **codex composer-idle 2004-cell** probe noted in the PR 7 context is a messaging concern,
  unrelated to browser control — it is tracked in its own thread, not here.
- **Mobile see-and-revoke** (design §10.3) is owed work with no plumbing yet — the phone can neither
  originate a browser drive nor (today) see or stop one. Not part of desktop v1's gate.
- The **partition reaper** (a deleted project leaves its `persist:nt-agent-browser-<id>` jar on disk)
  is a named follow-up, not a gate item.

---

Credit: browser control (S8) is a slice of external PR #112 by **@Corvin**. This gate closes S8
(PR 10 of 10).
