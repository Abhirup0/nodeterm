/**
 * The Server Edition's answer to `/control/*`: a NAMED, permanent refusal.
 *
 * `src/server/index.ts` starts the same hook server as the desktop but never calls
 * `setControlHandler`, so every control verb fell through to the null branch's
 * `{ ok: false, error: 'control unavailable' }` → HTTP 400. That sentence reads to a language model
 * exactly like a transient outage, **and a model retries an outage** — so an agent on a headless
 * host burned its turns re-sending a request that can never succeed, and the operator saw a stream
 * of 400s with nothing naming the cause.
 *
 * Registering a refusing handler rather than leaving the branch null is deliberate: the refusal
 * then travels the same reply shape as every other verb (JSON gets a machine-readable `error`, the
 * POSIX-sh shim gets one printable line), and nobody has to special-case "unavailable" downstream.
 *
 * Shared with the agent-messaging plan by agreement — one string, one mechanism, every verb.
 */

/** The machine-readable name. Structured clients key on this, never on the prose. */
export const CONTROL_UNSUPPORTED_ERROR = 'control-unsupported-on-this-edition'

/**
 * The prose, which must say the thing a retrying model needs to hear IN WORDS: the literal
 * "do not retry". A refusal that only a status code distinguishes from an outage is not a refusal
 * an agent can act on.
 */
export const CONTROL_UNSUPPORTED_SENTENCE =
  'Canvas control is not available on the nodeterm Server Edition. This is permanent on this ' +
  'host, not a temporary failure — do not retry.'

/**
 * `browser` gets one extra clause naming WHY it is structural, so nobody files it as unimplemented
 * and nobody tries to implement it here. A browser node on this edition renders in the VIEWER's own
 * Chrome tab: there is no Electron, no `webContents`, no `<webview>` and no CDP on this host, and
 * the server has no debugger for a page in somebody else's browser and never can.
 */
export const BROWSER_UNSUPPORTED_CLAUSE =
  'There is no browser control on this edition: a browser node here renders in your own browser ' +
  'tab, which this server has no debugger for.'

/**
 * One line, always — control replies are rendered as a single line by the shim, and a multi-line
 * body buries whichever half the reader stops at. The machine name is repeated inside the prose so
 * the text/plain dialect (which carries no `error` field) still names the refusal.
 */
export function controlUnsupportedMessage(verb: string): string {
  const why = verb === 'browser' ? ` ${BROWSER_UNSUPPORTED_CLAUSE}` : ''
  return `${CONTROL_UNSUPPORTED_ERROR}: ${CONTROL_UNSUPPORTED_SENTENCE}${why}`
}

/**
 * What `src/server/index.ts` hands to `hookServer.setControlHandler`. Never resolves `ok: true`:
 * there is nothing on this host for a control verb to act on.
 */
export async function serverEditionControlHandler({ verb }: { verb: string }): Promise<{
  ok: false
  error: string
  message: string
}> {
  return { ok: false, error: CONTROL_UNSUPPORTED_ERROR, message: controlUnsupportedMessage(verb) }
}
