# Gemini as a nodeterm agent

Gemini (`@google/gemini-cli`, `gemini` on PATH — measured here at **0.54.4**) is a builtin agent id
alongside claude, codex, opencode and grok: `AGENT_CONFIG.gemini` in `src/shared/agents/config.ts` —
label `Gemini`, colour `#4285f4`, `launchCmd: 'gemini'`, `promptInjectionMode: 'stdin-after-start'`,
`expectedProcess: 'gemini'`, and **no `argvPromptSeparator`** (grok is the only agent that asks for
one, pinned in `config.capabilities.test.ts`). Status comes from gemini's own hooks, never from
parsing output.

> **Unlike grok, almost nothing here is a guess.** The CLI is installed on the machine this
> integration was built on, and it **ships its own hook reference** at
> `/usr/lib/node_modules/@google/gemini-cli/bundle/docs/hooks/reference.md` (330 lines) plus a command
> reference at `bundle/docs/reference/commands.md`. Where those two are not specific enough, the
> answer was read out of the **shipped bundle JS** itself. Every claim below cites one of: that hook
> reference by line, the bundle by chunk + line, `gemini --help`, or a **captured** transcript
> (`src/core/__fixtures__/gemini/session.jsonl`, taken from
> `~/.gemini/tmp/nodeterm/chats/session-2026-08-09T10-48-fd01438b.jsonl` on this host). The few
> genuinely open items are marked *unverified* and collected in §7–§8.

---

## 1. What gemini is, capability by capability

Capabilities are membership lists in `src/shared/agents/config.ts`, not a flag bag. What matters for
maintenance is not *that* gemini is in a list but **what had to be true before it could join** — that
is the price of adding the next agent to the same list.

| List | gemini | What had to be true first |
|---|---|---|
| `AGENT_HOOK_TARGETS` | **joined** (pre-branch) | A normalizer for gemini's own event names (`normalizeGemini`, `src/shared/agents/normalize.ts`), a subscription list restricted to the events it maps (`GEMINI_HOOK_EVENTS`, `src/shared/agents/hook-events.ts`), and an installer — which is the *shared* one, because gemini keeps hooks in a single settings file exactly as claude does (`core/agents/hooks/gemini.ts` → `installHooksInto` on `~/.gemini/settings.json`). |
| `RESUMABLE_AGENTS` | **joined** (pre-branch) | `resumeCommand('gemini', id)` → `gemini --resume <id>`, and a session id that reaches the renderer off every hook payload. **Unverified:** that gemini's hook `session_id` is the id `--resume` accepts (its docs say so; no live run). |
| `USAGE_CAPABLE` (the per-node context meter) | **joined this branch** | BOTH numbers, from gemini's own transcript: a used count and a **trustworthy** window. Used = the newest turn line's `tokens.input` (`core/gemini-session.ts`). The window is the harder half, and the reason gemini could join at all is that its CLI states a **family rule with a catch-all default**, not a per-model table — so `geminiWindowFor` mirrors `tokenLimit()` and an unheard-of model still gets the right answer (§4). Plus a *third* thing that is easy to miss: **joining this list turns on more than the meter** — see the warning under the table. |
| `TITLE_READ_CAPABLE` | **joined this branch** (the list was created for it) | A read leg that resolves a session's own name **without searching another agent's tree** (`pickGeminiTitle` over the transcript path the context tail already tracks), and one routing rule for the readers: `readAgentSessionName` in `core/agent-session-name.ts`, serving the desktop IPC handler *and* both shells' session-name sweeps. This list exists **because of gemini**: it names its own sessions but cannot be told a name, so the read and write legs had to split (§6). |
| `RENAME_CAPABLE` | **deliberately NOT joined** | There is no rename command to write to. Gemini's session commands are `/chat` (an alias for `/resume`) with `debug | delete | list | resume | save | share` (`bundle/docs/reference/commands.md:52-100`), where `save <tag>` is a tagged **checkpoint**, not a title. One list for both legs would light the rename UI on a node where the write silently does nothing. **Invariant** (pinned in `config.capabilities.test.ts`): every `RENAME_CAPABLE` agent is also `TITLE_READ_CAPABLE`, never the reverse. |
| `PERMISSION_MODE_CAPABLE` | **joined this branch** | A per-agent **translation**, because gemini does not share claude's flag spelling: `--approval-mode default\|auto_edit\|yolo\|plan` (`gemini --help`, 0.54.4) against our `manual\|auto\|acceptEdits\|plan\|bypassPermissions`. The table is `GEMINI_MODES` in `src/shared/agents/approval-mode.ts`; §5 has the mapping and the one mode — `auto`, which is also the DEFAULT — gemini has no word for. |
| `CONTEXT_LINK_CAPABLE` | **joined** (pre-branch) | A parser for gemini's event-sourced chat format plus a locator by sessionId (`handoff/locate.ts`'s `locateGemini`), and a discovery route — the marker block merged into `~/.gemini/GEMINI.md`. |
| `TRANSFER_SOURCE_CAPABLE` | **joined** (pre-branch) | The same native-transcript reader cross-agent transfer needs. |
| `CANVAS_CONTROL_CAPABLE` | **joined** (pre-branch) | The marker block in `~/.gemini/GEMINI.md` (gemini gets no skill — that is claude's discovery mechanism, which grok borrows). Membership is what sets `NODETERM_CANVAS_CONTROL` in the session env. |
| `CHAT_CAPABLE` | not joined | The ⌘M `ChatPanel` renders **claude's** transcript `.jsonl`. Gemini's transcript is a different, event-sourced shape; the panel would need its own renderer. This list doubles as the "we can read and render this agent's transcript ourselves" fact — see the warning below. |
| `SUBAGENT_CAPABLE` | not joined | Subagent cards are driven by claude's `Agent`/`Task` tool correlation; gemini's equivalent vocabulary is not mapped. |
| `BRANCH_CAPABLE` | not joined | Branch sends claude's `/branch` and resumes by claude's session id; gemini has no counterpart. |
| `RECURRING_CAPABLE` | not joined | `/loop`, `/schedule`, `/cron` are detected from claude's `Skill` / `CronCreate` / `ScheduleWakeup` tool names. |

> **⚠ Ask what ELSE a list gates before joining it.** `hasUsage` gated **three** features, not one,
> and the `USAGE_CAPABLE` join above turned on all three at once. Two of them route through
> `core/transcript-ipc.ts`'s `resolveTranscript`, which has a **cwd fallback**: when the sessionId
> leg misses — and it always misses for a gemini or codex id, since no `<that id>.jsonl` exists under
> `~/.claude/projects` — it returns *the newest claude transcript for that cwd*. So `context.ensure`
> rehydrated a codex/gemini node's meter from a **stranger's claude session** (wrong numerator, wrong
> denominator, then flapping against the correct tail), and the find bar indexed that session's
> messages as this node's hits. Fixed by a pure predicate, `readsClaudeTranscript`
> (`src/renderer/lib/transcriptGates.ts`), which reuses `CHAT_CAPABLE` rather than adding a fourth
> list that would mean the same thing. The **meter** stays on `hasUsage`; what a non-claude agent
> gives up is only the mount-time head start — its meter fills on the first hook event after mount
> instead of instantly. Correct-but-later beats instant-but-borrowed.

---

## 2. The hook dialect: claude-shaped envelope, gemini's own event names

Gemini's **envelope** is the easy part. Its base input schema is claude's five fields
(`reference.md:46-58`):

```
session_id, transcript_path, cwd, hook_event_name, timestamp
```

**`transcript_path` is present** (`reference.md:53`) — the exact opposite of grok, which carries none
and forces a `(cwd, sessionId)` derivation plus a remembered `sessionId → dir` map in both shells.
For gemini the shells simply take the path they are handed, jail it, and hand it to the tail. That
one field is the difference between a five-line branch and grok's thirty.

What is **not** claude's is the event **names**. Gemini publishes **eleven** events
(`reference.md`, one `###` heading each — count it, the file has exactly eleven):

`BeforeTool` · `AfterTool` · `BeforeAgent` · `AfterAgent` · `BeforeModel` · `BeforeToolSelection` ·
`AfterModel` · `SessionStart` · `SessionEnd` · `Notification` · `PreCompress`

`GEMINI_HOOK_EVENTS` subscribes **seven** of them, and the four omissions are each for a different
reason:

| Left out | Why |
|---|---|
| `AfterModel` | **Fires per streamed chunk** — `reference.md:236`, "Fired for **every chunk** generated by the model", and its `fireAfterModelEvent(originalRequest, chunk)` call sits **inside the chunk loop** (`bundle/chunk-YMKYUNCI.js:331095`). Subscribing means one hook **process** per chunk. It is also the event carrying `llm_response.usageMetadata.totalTokenCount` — the one number worth having — which is exactly why the context meter reads the **transcript** instead (§4). Do not "just add AfterModel" to get the tokens. |
| `BeforeModel` | **NOT per-chunk** — it fires once per model request (`reference.md:189`, "Fires before sending a request to the LLM"; `fireBeforeModelEvent` at `chunk-YMKYUNCI.js:330773`, outside the loop). An earlier comment in `hook-events.ts` attributed per-chunk firing to both, and that was wrong. It is omitted for the plain reason the two below are: it reports nothing we render. A turn's start is already `BeforeAgent`. |
| `BeforeToolSelection` | `reference.md:204-219` — no state we render. |
| `PreCompress` | `reference.md:287-297` — no consumer. |

The seven map as follows (`normalizeGemini`); anything else returns `null`, a deliberate no-op:

| gemini event | `NormalizedAgentEvent` | note |
|---|---|---|
| `BeforeAgent` | `working`, `newTurn: true` | the turn start (mirrors claude's `UserPromptSubmit`); `newTurn` is what clears per-turn fan-out once per turn rather than on every tool event |
| `BeforeTool` / `AfterTool` | `working` | keeps RUNNING alive across a long tool call |
| `AfterAgent` | `done` | the turn end |
| `SessionStart` | session `start` | `source` is `startup\|resume\|clear` (`reference.md:250-251`) and maps unconditionally — a `/clear` really is one session ending and another beginning |
| `SessionEnd` | session `end` | `reason` is `exit\|clear\|logout\|prompt_input_exit\|other` (`reference.md:265-266`), likewise unconditional. Gemini subscribing `SessionEnd` is what lets the context tail untrack itself (codex does not, so its tail is released by `releaseNodeTails` instead) |
| `Notification` with `notification_type === 'ToolPermission'` | **`blocked`** + `lastMessage` | the addition this branch made — see below |
| `Notification`, any other type | **nothing** (`null`) | a **closed** match, on purpose |

### `Notification` is gemini's only ask-the-user signal, and it is matched as a closed set

Before this branch, a gemini node **sat on RUNNING while it waited for a permission answer**: the
last hook heard was `BeforeTool`, and gemini has nothing like claude's `PermissionRequest`.
`Notification` (`reference.md:272-285`) is the one signal that a human is being asked something.

`blocked` rather than `waiting` for two reasons: `normalizeClaude` already uses `blocked` for a
permission ask (every consumer treats them alike), and `BUSY_STATES` then **refuses an in-place
restart** on that node — correct, because `/quit` typed into a permission prompt would *answer the
prompt* instead of quitting. That refusal only became reachable for gemini once gemini joined
`EXIT_SEQUENCES` (§6): `restartEligibility` returns `not-resumable` before it ever consults
`BUSY_STATES`.

**The match is `=== 'ToolPermission'`, never a substring, and this is measured rather than cautious:**

- The docs name exactly one type (`reference.md:278`, `notification_type: ("ToolPermission")`).
- So does the **bundle**: `NotificationType` is an enum with exactly **one** member
  (`chunk-YMKYUNCI.js:333959-333962`), and the single call site is
  `fireNotificationEvent(NotificationType.ToolPermission, message, serializedDetails)`
  (`:362327`, inside `fireToolNotificationEvent`).
- And it fires **only for a real confirmation dialog**. `notifyHooks` is called from
  `resolveConfirmation` (`chunk-YMKYUNCI.js:340094-340101`) *after* `shouldConfirmExecute` has
  returned details; when it returns nothing the code takes `outcome = ProceedOnce; break;` and the
  notification never happens. **An auto-approved or `yolo` tool call therefore fires nothing.**

That last point is what makes gemini structurally safe from **grok's strobe**: there,
`type.includes('permission')` turned a notification grok emits before *every* tool call into a
NEEDS YOU badge plus a chime plus an OS notification plus a phone inbox card, **per tool call**.
Widening gemini's test "to be safe" is the unsafe direction — an unknown future type must stay a
no-op, because a badge stuck on a finished node has no later hook to clear it.

Nothing here can be *answered* from our side: the hook is observability only and its flow-control
fields are ignored (`reference.md:284-285`), so this reports state and no more — no `pendingId`,
unlike claude's deterministic-approval path.

### Hook installation

`core/agents/hooks/gemini.ts` is a thin wrapper over the shared `installHooksInto` on
`~/.gemini/settings.json` — **merged and idempotent**, preserving other tools' hooks, exactly as
claude's is. The event list is imported from `GEMINI_HOOK_EVENTS`; **the SSH installer imports the
same constant** (`src/main/remote-ssh/remote-hooks.ts:57-59`, `AGENT_TARGETS`). That is not
cosmetic: the two lists used to be declared separately and had drifted so far that the remote
installer subscribed gemini to **claude's** event names, which gemini never fires — remote gemini
nodes reported no status at all. One definition is the fix.

Gemini's events are **plain strings**, so its emitted config is byte-identical to what it has always
been; only grok needs the `{ event, matcher }` form of `ManagedHookEvent`.

---

## 3. Where gemini's conversation lives

```
~/.gemini/tmp/<project>/chats/session-<ISO-ish stamp>-<short id>.jsonl
```

— the same root `handoff/locate.ts`'s `locateGemini` walks, and the root the **transcript jail** was
widened to. That widening is the security-relevant part: hook POSTs can arrive over the remote
reverse tunnel, so a forged POST must not aim a file read at an arbitrary local path.
`isSafeLocalTranscriptPath` (`core/claude-accounts-core.ts:79-102`) now admits four roots —
claude's `~/.claude/projects`, a managed account's `{userData}/claude-accounts/<id>/projects`,
**gemini's `~/.gemini/tmp`**, and codex's `<codexHome>/sessions`. **Per root, never `$HOME`**: this
predicate exists precisely so a forgery cannot reach `~/.ssh/id_rsa`, and a home-wide allowance
hands that straight back.

The transcript is **event-sourced**, which shapes both readers below: a line is an append, and a
**resume replays the prior history into a single `{"$set":{"messages":[…]}}` line**. Both readers
therefore scan **backwards** for the newest line that parses to something they accept
(`latestJsonLineWhere` in `core/gemini-session.ts`, shared with `codex-session.ts`), with the needle
as a cheap pre-filter only — a line can mention a key deep inside without carrying it at the top
level, and gemini's `$set` line is exactly that case.

---

## 4. The context meter: `tokens.input`, and gemini's own `tokenLimit()`

**Used tokens** — measured shape, `__fixtures__/gemini/session.jsonl` line 29:

```json
"tokens":{"input":17149,"output":29,"cached":7760,"thoughts":171,"tool":0,"total":17349},
"model":"gemini-3.5-flash"
```

Both fields are on the **same line**, which is what lets one backward scan settle used *and* window.

- `input` is the used count — it is what fills the window at that turn. `total` folds in `output`
  and `thoughts`, which have already left the prompt; the fixture proves the split
  (`input + output + thoughts + tool === total` on every line).
- **`cached` is NOT added.** It is a **subset** of `input` (cached input still occupies the window and
  is already counted there), so adding it double-counts. **Claude is the opposite** — its input
  *excludes* cache reads, which is why `context-tail.ts`'s `parseLatestUsage` sums them. **The two
  formulas must not be unified.** Codex is a third variant with the same trap in the same direction
  (`cached_input_tokens` inside `input_tokens`); see `core/codex-session.ts`.

**The window** is where gemini earned its place in `USAGE_CAPABLE`. Its transcript states no
denominator, so the model id is the only signal — but gemini does not need a *guess*, because the
CLI's own resolver is a family rule with a catch-all default. Read out of the shipped bundle
(`chunk-BS6BSLZD.js:331674-331686`):

```js
var DEFAULT_TOKEN_LIMIT = 1048576;
var GEMMA_4_TOKEN_LIMIT = 256e3;
function tokenLimit(model) { switch (model) {
  case GEMMA_4_31B_IT_MODEL: case GEMMA_4_26B_A4B_IT_MODEL: return GEMMA_4_TOKEN_LIMIT
  case PREVIEW_GEMINI_MODEL: … case DEFAULT_GEMINI_FLASH_LITE_MODEL: return 1048576
  default: return DEFAULT_TOKEN_LIMIT } }
```

`geminiWindowFor` (`core/model-window.ts`) mirrors that and **only** that: the two gemma models as
the special case, everything else on the **1 M default**. The five named 1 M cases are redundant, and
copying them would only create something to go stale — an unknown or newly released gemini model gets
the *right* answer from the default, which is exactly what a per-model allowlist would get wrong,
silently, with a confident wrong denominator. The fixture's `gemini-3.5-flash` is in neither list and
lands on the default, which is evidence the default branch is the one carrying the feature.
`null` only when the transcript names no model at all — then the meter stays hidden rather than
dividing by an invented number.

Plumbing: **one tail per agent, each with its own parser** — not one tail switching on an agent id,
which would have meant changing `ContextTail.track(sessionId, path)` and its four call sites. The
poller (offset reads, torn-line carry, change-gated push) is written once in `createContextTail`;
only `parse` differs (`geminiContextParse` / `codexContextParse`). Neither gets
`onTaskNotification`/`onToolResult` — both are claude transcript features. **Both shells** create
both tails and both jail the path the same way (`src/main/index.ts:1178-1182`,
`src/server/agent-status.ts`); the desktop's copy additionally skips **remote (SSH)** nodes, whose
transcript is on the host, while the server has no SSH-project manager and so has nothing to skip.

---

## 5. Permission mode: `--approval-mode`, and the mode gemini has no word for

`activePermissionMode(agentId)` resolves the project override, else `settings.claudePermissionMode`
(the persisted key keeps its name — renaming it would silently reset every existing user's choice).
`withPermissionMode` in `src/shared/agents/approval-mode.ts` is the single funnel; **where** the flag
lands is decided one layer up by `createAgentNode`, and for gemini it goes **last** (no
`argvPromptSeparator`), so the composed line stays the historical shape.

`gemini --help` (0.54.4): `--approval-mode` `[choices: "default", "auto_edit", "yolo", "plan"]`.

| nodeterm mode | label | gemini flag | note |
|---|---|---|---|
| `manual` | Ask each time | *(none)* | gemini's own `default` is documented as "prompt for approval", which is exactly what the label promises — so no flag reproduces it, as it does for claude |
| `auto` | Auto | *(none)* | **no equivalent** — see below |
| `acceptEdits` | Accept edits | `--approval-mode auto_edit` | the direct equivalent ("auto-approve edit tools") |
| `plan` | Plan | `--approval-mode plan` | "read-only mode" |
| `bypassPermissions` | Bypass all | `--approval-mode yolo` | "auto-approve all tools" |

**`auto` emits no flag, and that is the whole reason this section exists.** `auto` is
`DEFAULT_PERMISSION_MODE`, so this row decides what an **untouched install** launches gemini with.
Gemini's vocabulary is exactly those four values, and none of them means "approve most things but
NOT edits" — the nearest, `auto_edit`, is "auto-approve edit tools", i.e. the opposite end of the one
axis our `auto` is about. The first version of this table mapped `auto → auto_edit` anyway, and the
consequence was concrete: **every existing gemini node would have started auto-approving file edits
on upgrade, with no notice.** Before gemini joined `PERMISSION_MODE_CAPABLE` it always launched bare
(= gemini's `default` = *prompt for approval*), and `modeSupported('gemini','auto')` would have
answered `true`, so `unsupportedModesNote()` would not have admitted it either — a silent widening of
permissions dressed as a translation. So `auto` is **absent from `GEMINI_MODES`**,
`modeSupported('gemini','auto')` is **false**, and the launch is the bare pre-branch command. This is
the branch's own rule applied to gemini instead of exempted from it: a mode the CLI cannot express
emits no flag, never a substituted nearest match (the same reason codex's `plan` and `acceptEdits`
emit nothing). The cost is that `auto` and `manual` land on the same gemini policy — but that policy
is the *prompting* one, which is the safe direction, and the derived copy now says it out loud:

> Auto has no Gemini equivalent, so Gemini sessions start in Gemini's own default.

Pinned by `approval-mode.test.ts` ("emits NO flag for `auto`, the default mode, rather than
auto-approving edits"), which asserts the flags, `modeSupported`, the composed command line, and that
the note names gemini and the mode.

**Gemini does NOT inherit claude's `auto` version gate.** That gate exists because Claude Code
< 2.1.71 *exits 1* on `--permission-mode auto`, and it is fed by a `claude --version` probe (local, or
the SSH host's). Gemini accepts every value in the table on the version measured, so gating it on
claude's probe would downgrade a gemini session on a machine whose *claude* is old or absent.
`activePermissionMode` gates only `agentId === 'claude'`, `ensureActivePermissionMode` awaits the
probes only for claude, and `sshAutoModeHint`'s copy names Claude in every sentence for the same
reason. **An agent needing its own gate adds one beside claude's.**

**Security, re-stated because it is easy to lose:** mode values come from hand-editable, git-shared
JSON (`settings.json` / `project.json`) and end up interpolated into a shell command line (tmux
`send-keys`), so the mode is **re-validated at the interpolation site** — `isPermissionMode` at the
top of `approvalFlags`, mirroring `permissionModeFlag`. The type proves nothing. Without that guard a
forged `constructor` indexes a plain-object table and hands back a **Function**, which would have been
stringified onto the `send-keys` line. An unrecognized mode yields the bare, safe command. The same
hole exists on the **agent id** (`AgentId` is open — custom agents carry user-typed ids), which is why
`dialectFor` looks its record up through `Object.hasOwn` too, and why flag + vocabulary are ONE record
per agent (`APPROVAL_DIALECTS`): the previous shape was a `tableFor` ternary plus a `flagFor` ternary
whose `else` branch was codex's flag, so a third agent added to the table and forgotten in the flag
would have emitted `--ask-for-approval <a gemini-style value>` — a failed launch from an edit that
looks complete.

`--sandbox` is deliberately untouched: it is a separate axis, and folding it in would widen
filesystem access invisibly.

---

## 6. Title, restart, and the `--delete` trap

### The title is READ-ONLY, and that is why `TITLE_READ_CAPABLE` exists

Gemini names the conversation itself, through its own **`update_topic` tool**, so the name lives in
that call's arguments — **not** in a top-level transcript field (verified against the captured
fixture: no line parses to an object with a `title`). Measured, `__fixtures__/gemini/session.jsonl`
line 22:

```json
"toolCalls":[{"name":"update_topic","args":{…,"title":"Test Environment Verified","summary":"…"}}]
```

`pickGeminiTitle` matches on the tool **name**, so a `title` argument belonging to some other tool can
never be mistaken for the session's name, and takes the **last** call within a line (a line can hold
several; the newest is the name). Ordering across lines is right for free: the backward scan takes the
newest matching line.

**Two places, because of resume.** A resumed session replays its history into one
`{"$set":{"messages":[…]}}` line, so a title set *before* the resume is nested in that line's messages
rather than appearing as a top-level tool call — and the first, top-level-only version of this reader
answered `null` for the whole resumed session, which is precisely the case the read leg exists for (a
resume is when the OSC title is gone). So `$set.messages` is searched as a fallback, newest message
first. **Provenance, stated honestly:** `$set.messages` being an array of ordinary message objects is
measured (fixture line 2) and a message carrying `toolCalls[].args.title` is measured (line 22); the
**combination** is composed from the two, not captured from a real resume. If gemini nests differently
this degrades to `null` — the node keeps its own title — never to a wrong name.

The read is a **bounded tail** (`readSmallTail(p, TITLE_TAIL_BYTES)`, the same cap claude's title read
uses) of the path **the context tail already tracks**. Nothing scans. That path authority is created
per shell, so it reaches the router as an injected dep (`AgentSessionNameDeps.geminiPathFor`), and in
`src/main/index.ts` it is deliberately held in a **`let` assigned when the tail is created** and called
with `?.` (`:573-575`) rather than closed over as a `const` declared 600 lines later: the later `const`
makes an early call a **TDZ `ReferenceError`**, and `TerminalNode`'s poll does not catch its
`readSessionName` rejection — one throw kills that node's poll chain for the whole mount. A poll *can*
fire early, because `sessionId` is persisted in localStorage and a cold relaunch has one before any
hook arrives. Undefined-until-assigned degrades instead: no path, no name, next tick tries again.

There is **no write leg**. Gemini is in `TITLE_READ_CAPABLE` and **not** in `RENAME_CAPABLE`, so the
three `/rename` push sites stay claude+grok and the rename UI never lights on a node where the write
would silently do nothing.

**Routing is not cosmetic:** claude's resolver *scans* `~/.claude/projects` on a cache miss, and a
gemini session id can never be found there — so an unrouted gemini node would pay that scan on every
poll (a mounted node polls every ~4 s until the name first resolves, and the mirror's sweep adds a
pass a minute) for a guaranteed `null`.

The sweep gate lives in **core**, not in the shells: `startSessionNameSweep` defaults its `supports`
dep to `supportsTitleRead` (= `canReadTitle`, `core/session-name-sweep.ts:25`), and **neither shell
passes `supports:` any more**. That is a deliberate de-duplication: both shells previously carried
their own copy of the gate, reverting both to `canRename` left the entire suite green while silently
skipping every gemini node, so the mirror and the phone would never see a gemini name. Same drift
class bit this branch **three** times (the remote installer's event lists, the grok raw-listener
block, this) and the fix each time was one definition in `src/core`.

### In-place restart: `/quit`, and never `--delete`

`EXIT_SEQUENCES.gemini = '/quit'` (`renderer/terminal/agent-restart.ts`), measured from gemini's own
`bundle/docs/reference/commands.md:325` (`/quit`, alias `/exit`). Adding it is what makes "Restart
agent (resume)" work on a gemini node: `restartEligibility` returns `not-resumable` for an agent with
no exit sequence, before it ever consults `BUSY_STATES`.

**The value must stay BARE.** The same command takes a `--delete` flag that exits **and permanently
deletes the session's history and temporary files** (`commands.md:329-332`) — the very conversation
the restart exists to resume. A dedicated test asserts the whole written stream contains no
`--delete` (`agent-restart.test.ts`, "never types the history-destroying `--delete` flag"), and
`exitSequence('gemini')` is separately asserted `not.toContain('--delete')`.

Choreography is agent-agnostic: write `KILL_LINE` (Ctrl-U) then the exit line, poll
`pane_current_command` until a shell owns the pane, then echo-deliver `resumeCommand`. Nothing is
ever killed; a session that has not quit inside the timeout reports `exit-timeout` and keeps running.
A `working` **or `blocked`** node is refused. **Unverified:** that Ctrl-U is clear-line inside gemini's
TUI — the same assumption the module already carries for claude/codex/grok, and its cost if wrong is
one stray keystroke.

---

## 7. The three surfaces

| Feature | Desktop | Server Edition (browser) | Mobile (`~/projects/nodeterm-ios`) |
|---|---|---|---|
| Status hooks → badges, unread dot, notification | yes | yes — `wireAgentStatus` broadcasts the same normalized events | yes, for free — the agent-status mirror threads `agentId` and is otherwise agent-agnostic |
| `Notification` → NEEDS YOU (the fix this branch made) | yes | yes, same normalizer | yes, via the mirror's needs-you edge |
| Hook installation | `installGeminiHooks()` at launch, plus the `AGENT_TARGETS` loop per SSH connect | same core installer (`core/agents/hooks/*` is Electron-free) | N/A — the phone installs nothing |
| Context meter | yes — `geminiContextTail` + the widened jail | **yes**, wired identically in `src/server/agent-status.ts` (a rare case where the server got the feature in the same change) | the mirror's per-node context ring gets it for free — `pushContextUpdate` feeds `recordContextUsage` in both shells |
| `context.ensure` mount-time rehydration | **claude only, deliberately** (`readsClaudeTranscript`) — a gemini node's meter fills on its first hook event after mount instead of instantly | it has no server handler at all, so this was never reachable there | N/A |
| Session title read | yes | **no — pre-existing gap, not a gemini one.** `ws-bridge.readSessionName` returns `''` (`src/renderer/bridge/ws-bridge.ts:240`): `IPC.ptyReadSessionName` has never been registered server-side, so **claude's** read leg is equally stubbed. The fix is to move the routing into core and register it from both shells, exactly as `core/transcript-ipc.ts` did for the ⌘M channels | the mirror's session-name **sweep** runs in both shells and routes per agent (`supportsTitleRead`), so a gemini name reaches the phone |
| Rename write | **N/A** — gemini has no rename command (§6) | idem | idem |
| Permission mode | yes | yes (pure renderer + the flag) | **follow-up owed** — see §8 |
| In-place restart + cold-restore resume | yes | yes | N/A |
| ⌘M transcript view (`ChatPanel`) | **not implemented for gemini** — `CHAT_CAPABLE` is claude-only; the panel parses claude's JSONL | idem | idem |
| Find bar's transcript index | **claude only** (`readsClaudeTranscript`); the terminal-buffer search works normally | idem | N/A |
| Context links | yes (`CONTEXT_LINK_CAPABLE`), marker block in `~/.gemini/GEMINI.md` | **not wired at all** — `initContextLink` is never called from `src/server` | N/A |
| Canvas control | yes, marker block + the sh+curl shim | **not wired** — `agent:control` has no server handler; pre-existing | N/A — no canvas |
| Managed accounts | **N/A** — accounts are a claude config-dir mechanism; `createAgentNode` never stamps an `accountId` on a non-claude node, and `CLAUDE_CONFIG_DIR` is irrelevant to `~/.gemini/settings.json` | idem | idem |
| Working indicator | the **brand mark, breathing** — `brandPulsePlan('gemini', …)` returns the `gemini-color.svg` asset and it pulses with a bloom, on the canvas badge and in the notch strip. Before this branch gemini fell through to the plain dot, which says "something is happening" but not *who* | **N/A** for the notch (there is none); the canvas badge works | the phone has its own SwiftUI renderer |
| Fullscreen TUI setting | **N/A** — `claude-tui.ts` writes claude's `"tui": "fullscreen"`; gemini has no analogue | idem | idem |
| Deterministic hook-reply approvals (phone Approve/Deny) | **claude only** — `pty-manager` arms `NODETERM_PERM_WAIT_SECS` for claude alone, and gemini's `Notification` is explicitly observability-only (`reference.md:284-285`), so there is nothing to answer | idem | a gemini node's approvals are not answerable from the phone |
| Kanban card + card modal | badges, the meter row and the 💬 comments panel all work (derived from the same nodes and the same status store) | same | the iOS board is a separate read/move mirror |

---

## 8. Known gaps and follow-ups

**Gaps in what shipped** — state them, do not paper over them:

1. **A DENIED tool may hold NEEDS YOU until the next prompt.** On Cancel, `AfterTool` never fires
   (the Cancel branch returns before the call is even scheduled, `chunk-YMKYUNCI.js:346153-346157`)
   and `fireAfterAgentHookSafe` early-returns while `pendingToolCalls` remain
   (`chunk-YMKYUNCI.js:344652`) — so the badge is cleared by the *next* turn's `BeforeAgent`.
   Self-healing, and still strictly better than the pre-branch stuck RUNNING, but gemini has no idle
   rescue notification the way grok might. Measure it: deny a tool live and watch whether the badge
   clears (§9 item 5).
2. **`auto` and `manual` are indistinguishable at launch** (§5): gemini has no value for `auto`, so
   both emit no flag and land on gemini's own prompting `default`. Closed as far as honesty goes —
   `modeSupported` is false and the derived copy says so — but the dropdown still offers two entries
   that do the same thing on gemini. Only a gemini-side "approve non-edit tools" value could
   separate them.
3. **The resumed-transcript title path is composed, not captured** (§6). Fail-safe by construction:
   wrong ⇒ `null`, never a wrong name. Closing it needs one real resumed transcript.
4. **A remote (SSH) gemini node has no meter and no title.** The tails deliberately never track a
   remote node's transcript — metering the local disk would report the wrong machine — and
   `geminiPathFor` then answers `undefined`, which reads as "no name". Honest, but a real asymmetry:
   claude's leg handles remote via `setRemoteTranscriptReader` and a remote-jailed path.
5. **The search button's tooltip still keys on the meter.** `TerminalNode.tsx:3234` reads
   `showUsage ? 'Search terminal + conversation' : 'Search this terminal'`, so a gemini/codex node
   promises a conversation search whose transcript leg is now off. One word (`claudeTranscript`) fixes
   it; recorded here rather than fixed in a docs commit.
6. **Nothing tests the call sites of `readsClaudeTranscript`, behaviourally.** No test in this repo
   renders `TerminalNode` or `Canvas`, so the gates are pinned by a source-text guard
   (`src/renderer/nodes/title-gate.test.ts`, in the style of `no-electron.test.ts`) — three of its six
   mutations are caught by identifier matching, not behaviour. Its `toContain` on a 6000-line file also
   dumps unrelated source as the failure diff, and its "Canvas.tsx must never mention `canReadTitle`"
   clause would false-positive on a future legitimate read there.
7. **`codexHome()` returns `$CODEX_HOME` unresolved**, so a `~/…` or relative value still misses the
   jail — pre-existing, and identical to `codex-usage.ts`'s own behaviour. It fails **closed** (the
   meter silently never fills), which is the quieter and therefore worse failure.
8. **The prefix-based jail admits a symlink planted inside an allowed root.** Pre-existing for
   claude's roots; both new consumers turn the file into numbers, never raw bytes.

**Follow-ups owed elsewhere:**

- **`~/projects/nodeterm-ios`** — the phone's `AgentLaunch.command` appends the permission-mode flag
  only for claude, so a gemini launch from the phone gets **no flag** (not a wrongly gated one), and
  `MirrorSettings.autoSupported` still has no agent dimension. Recorded from that repo in
  `docs/grok-agent.md` §8; **not re-verified here** — the iOS checkout is absent from this worktree, so
  treat the line references there as the last known state.
- **Per-agent `context.ensure` rehydration** — its own task, not a gate: teach it to resolve
  gemini's/codex's own transcripts (`handoff/locate.ts` already has `locateGemini`/`locateCodex` by
  sessionId) and route to the matching tail.

---

## 9. Gemini device checklist

Far shorter than grok's, because the CLI and a real transcript were both available here. These are
the items that genuinely need a running session. Run them in a project with one gemini node, one
claude node, and one SSH project.

```
Hooks + state machine
 1. Start `gemini` in a node: does the RUNNING badge appear on the first prompt and clear at
    the end of the turn? (BeforeAgent / AfterAgent reaching the hook server at all.)
 2. Trigger a real tool-permission prompt. Does the badge switch to NEEDS YOU — i.e. is the live
    payload's `notification_type` exactly "ToolPermission"? (Statically closed from the bundle's
    one-member enum, so this is a confirmation, not an unknown.)
 3. APPROVE it: the badge must go back to RUNNING (BeforeTool/AfterTool), then clear.
 4. Run a turn under `--approval-mode yolo`: NO Notification should fire at all (an auto-approved
    call never reaches notifyHooks). A NEEDS YOU here would mean the strobe grok had.
 5. DENY a tool. Expected (§8.1): the badge may STAY on NEEDS YOU until the next prompt's
    BeforeAgent clears it. Confirm, and record how bad it feels — that decides whether a rescue
    is worth building.
 6. `/clear` mid-session: SessionEnd + SessionStart both fire, the meter untracks and refills.

Context meter
 7. Does the meter fill, and does its % move as the conversation grows? Compare against gemini's
    own context readout in the TUI.
 8. Does the popover name the GEMINI model (not "claude")? And on a fresh mount, does the meter
    start EMPTY and fill on the first hook event (the deliberate loss of the head start, §1)?
 9. Run a gemma model if you can reach one: the window must be 256k, not 1M.

Title
10. Let gemini name the conversation (it calls update_topic on its own), then check the node title
    adopts it — and that a HAND rename stops the poll overwriting it (titleAuto=false).
11. RESUME that session (`gemini --resume <id>`) and check the title survives. This is §8.3: if the
    title goes blank until gemini renames again, capture the resumed transcript's first line and
    fix pickGeminiTitle's $set shape against it.
12. Confirm there is no rename affordance offered on a gemini node.

Modes + restart
13. Launch each mode from Settings → Agents and confirm the emitted flag: manual ⇒ NO flag,
    **auto ⇒ NO flag** (§5 — the one that matters, since `auto` is the default: a gemini session
    started with the setting untouched must PROMPT before an edit, not auto-approve it),
    acceptEdits ⇒ auto_edit, plan ⇒ plan, bypassPermissions ⇒ yolo. Check a session really STARTS in
    it, not just that the flag parses.
14. On a machine with NO claude installed, does an `auto` gemini launch still carry its flag?
    (claude's version gate must not touch gemini.)
15. "Restart agent (resume)" on an idle gemini node: does it /quit, wait for the shell, and resume
    the SAME conversation? Is it refused while the node is RUNNING or NEEDS YOU? Is the history
    still there afterwards (i.e. `--delete` was never typed)?
16. Ctrl-U inside gemini's TUI: is it clear-line? (If not, one stray keystroke precedes /quit.)

SSH + surfaces
17. Connect an SSH project, then on the host: is our hook block in `~/.gemini/settings.json`, with
    the SEVEN gemini event names (not claude's)? Do remote gemini badges work?
18. A remote gemini node has NO meter and NO title by design (§8.4) — confirm it degrades quietly
    rather than showing a wrong number.
19. Server Edition in a browser: badges, NEEDS YOU, and the context meter must all work; the node
    title will NOT adopt gemini's name (readSessionName is stubbed server-side, §7).
20. Phone: does a gemini node show the right state and a context ring? Its permission-mode flag is
    missing on phone-side launches (§8).
21. macOS notch + canvas badge: does the gemini mark pulse and bloom, in BOTH themes? Its mark is a
    gradient, so the `currentColor` bloom is the LABEL colour, not its own ink — the light theme is
    where that will look worst if it looks bad anywhere.
22. Kanban card + card modal: badges, the meter row and the 💬 comments panel on a gemini card.
```
