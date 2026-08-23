import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import {
  WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS,
  terminateWindowsProcessTree
} from './windows-process-tree'

/**
 * The Windows kill path had no test of its own, on the platform this app ships to.
 *
 * It is what `host.ts` actually calls to end a session — node-pty defers WindowsTerminal.kill()
 * until a terminal's first output, so a silent process would otherwise stay alive forever — and its
 * doc comment makes a strong safety claim: "success is acknowledged only after the root PID is also
 * observed absent. A timeout is always rejection." Nothing verified that. The one test that reaches
 * this path (host-routing's kill-acknowledgement case) is skipped on win32 precisely because it
 * fakes node-pty, which the Windows branch never calls.
 *
 * These use a REAL child process, because the claim being checked is about a real process actually
 * being gone. A fake cannot disagree with the implementation about that.
 */
describe('terminateWindowsProcessTree', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ESRCH'
    }
  }

  // `ping.exe` directly, never `cmd.exe /c ping`. The wrapper is what the first version of this
  // file used, and `child.kill()` then ends cmd while leaving ping running for its full 30 seconds
  // — measured, not assumed: one orphan survived every kill. That is precisely the failure the
  // function under test exists to prevent, so a test for it that leaks processes is worse than
  // funny; a suite that spawns real shells elsewhere then competes with the litter.  }

  it('refuses to run at all off Windows, rather than pretending to have killed something', async () => {
    if (process.platform === 'win32') return
    await expect(terminateWindowsProcessTree(999_999)).rejects.toThrow(/unavailable on this platform/)
  })

  it('refuses an invalid pid and its own process, before touching taskkill', async () => {
    // These guards run before the platform-specific work, so they hold everywhere and are the
    // cheapest place to prove the helper cannot be aimed at the host itself.
    await expect(terminateWindowsProcessTree(process.pid)).rejects.toThrow(/Refusing to terminate/)
    await expect(terminateWindowsProcessTree(0)).rejects.toThrow(/Refusing to terminate/)
    await expect(terminateWindowsProcessTree(-1)).rejects.toThrow(/Refusing to terminate/)
    await expect(terminateWindowsProcessTree(1.5)).rejects.toThrow(/Refusing to terminate/)
  })

  it.skipIf(process.platform !== 'win32')(
    'kills a real silent process and reports only after it is gone',
    async () => {
      // A process that produces no early output: `ping -n` just waits, which is the exact shape
      // this helper exists for, because node-pty defers its own kill() until a first write.
      const child = spawn('ping.exe', ['-n', '30', '127.0.0.1'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      const pid = child.pid
      expect(pid).toBeTypeOf('number')
      expect(alive(pid as number)).toBe(true)

      await terminateWindowsProcessTree(pid as number)
      expect(alive(pid as number)).toBe(false)
    },
    WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS + 20_000
  )

  it.skipIf(process.platform !== 'win32')(
    'does not report success until the pid is actually observed absent',
    async () => {
      // The claim the source makes, now actually held to it. The injected probe reports the
      // process alive for the first few polls and only then absent, which is the race the loop
      // exists for and which cannot be produced by killing a real child — taskkill /F has already
      // finished by the time the promise would settle.
      const child = spawn('ping.exe', ['-n', '30', '127.0.0.1'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      const pid = child.pid as number
      let polls = 0
      const laggingProbe = (): boolean => {
        polls += 1
        return polls <= 4
      }

      const started = Date.now()
      await terminateWindowsProcessTree(pid, laggingProbe)
      const waited = Date.now() - started

      // It polled until the probe said absent, rather than resolving on taskkill's return.
      expect(polls).toBeGreaterThan(4)
      // Four extra polls at the 25 ms cadence cannot have taken no time at all.
      expect(waited).toBeGreaterThanOrEqual(80)
    },
    WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS + 20_000
  )

  it.skipIf(process.platform !== 'win32')(
    'rejects when the tree never goes away, rather than acknowledging a kill it cannot prove',
    async () => {
      // A timeout is always rejection — the other half of the same sentence in the source.
      const child = spawn('ping.exe', ['-n', '30', '127.0.0.1'], {
        windowsHide: true,
        stdio: 'ignore'
      })
      const pid = child.pid as number
      try {
        await expect(terminateWindowsProcessTree(pid, () => true)).rejects.toThrow(
          /is still alive after/
        )
      } finally {
        child.kill()
      }
    },
    WINDOWS_PROCESS_TREE_TERMINATION_TIMEOUT_MS + 30_000
  )

  // The absence poll is now genuinely guarded: neutering the loop to `while (false)` turns the two
  // tests above red. It was not, before the `isAlive` seam existed — a test written against a real
  // child passed either way, because `taskkill /F` has already finished by the time the promise
  // settles. That is the whole reason the seam is there, and why it was worth a production
  // parameter that production never passes: without it, this file could only ever have documented
  // the gap instead of closing it.
  it.skipIf(process.platform !== 'win32')(
    'rejects for a pid that does not exist rather than reporting a kill it never made',
    async () => {
      // taskkill fails for an unknown pid, and the helper never converts an execution error into
      // success — the comment in the source says so, and this is what holds it to it.
      const child = spawn('cmd.exe', ['/c', 'exit'], { windowsHide: true, stdio: 'ignore' })
      const pid = child.pid as number
      await new Promise<void>((resolve) => child.once('exit', () => resolve()))
      await expect(terminateWindowsProcessTree(pid)).rejects.toThrow(/termination failed for PID/)
    },
    30_000
  )
})
