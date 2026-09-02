/**
 * What the UI calls the machine nodeterm is running on.
 *
 * There used to be no such helper: 30-odd user-visible strings said "this Mac", including the
 * license and team-access copy. On Windows that is untidy in Accounts and actively harmful in
 * billing — a user reading *"This Mac is not authorized on this license"* can no longer tell
 * whether the sentence is even about their machine, and *"a teammate on a seat can run commands
 * on this Mac"* is the sentence someone has to trust before handing out shell access (issue #563).
 *
 * One definition, so a new string cannot reintroduce the assumption, and so the noun agrees
 * everywhere it appears in one dialog.
 *
 * **A brand name is only used where we KNOW the machine.** The desktop renderer runs on the host
 * it describes, so the OS sniff is authoritative there. A Server Edition browser tab does not:
 * the license, the seats and the sessions belong to the SERVER, whose OS the viewer's `navigator`
 * says nothing about — so a browser tab always gets the neutral word rather than a confident
 * wrong one. Same for any non-DOM context.
 *
 * Deliberately NOT applied to copy that really is macOS-specific: `PtyPressureBanner`
 * (`kern.tty.ptmx_max`) and the onboarding notch step (which only exists on macOS).
 */
import { isMacPlatform, isWindowsPlatform } from '@shared/platform-utils'
import { isBrowserRuntime } from '../bridge/runtime'

export type MachineNoun = 'Mac' | 'PC' | 'computer'

/** The bare noun: "Mac" / "PC" / "computer". */
export function machineNoun(): MachineNoun {
  if (typeof navigator === 'undefined' || isBrowserRuntime()) return 'computer'
  if (isMacPlatform()) return 'Mac'
  if (isWindowsPlatform()) return 'PC'
  return 'computer'
}

/** "this Mac" / "this PC" / "this computer" — mid-sentence. */
export function thisMachine(): string {
  return `this ${machineNoun()}`
}

/** "This Mac" / "This PC" / "This computer" — sentence start, or a standalone label. */
export function thisMachineCap(): string {
  return `This ${machineNoun()}`
}

/** "other Macs" / "other PCs" / "other computers". */
export function otherMachines(): string {
  return `other ${machineNoun()}s`
}
