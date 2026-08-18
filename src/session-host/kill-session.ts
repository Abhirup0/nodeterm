import type { HostSession } from './session'

/** Request a real process kill before entering the one retirement path. A thrown kill is unknown,
 * not evidence that the process is already dead: propagating keeps the generation registered and
 * prevents a false successful deletion of a still-running unmanaged PTY. */
export async function killHostSession(
  session: HostSession,
  beginRetirement: (session: HostSession) => Promise<void>
): Promise<void> {
  if (!session.exited && !session.retiring) session.proc.kill()
  await beginRetirement(session)
}
