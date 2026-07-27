// Which shell is this renderer running under?
//
// Almost nothing needs to ask — the whole point of `window.nodeTerminal` is that the two shells
// look alike, and a feature that differs should degrade through a member that answers "not here"
// (the `satisfies NodeTerminalApi` doctrine). But a couple of AFFORDANCES have to be decided
// before any call is made: "Reveal in Finder" is inert in a browser tab, and a download is offered
// by a different route on each shell. Probing by minting a ticket would be worse than asking.
//
// The flag is set by the boot switch in `main.tsx` — the one place that already knows, because it
// is the place that installs the bridge. Kept in its own module (rather than on `window`) so the
// desktop bundle never pulls the bridge in just to read it.
let browserRuntime = false

/** Called by the boot switch when it installs the WS bridge (i.e. there is no Electron preload). */
export function markBrowserRuntime(): void {
  browserRuntime = true
}

/** True in a browser tab (Server Edition), false under Electron. */
export function isBrowserRuntime(): boolean {
  return browserRuntime
}
