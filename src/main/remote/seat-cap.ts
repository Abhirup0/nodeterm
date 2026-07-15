// Team Access seat cap (pure). The relay host may hold up to `seats` live/pending peer sessions at
// once; `seats` is resolved from the license entitlement (core/license.ts `licensedSeats()`).
//
// This is HOST-SIDE / UX enforcement, NOT a server-guaranteed limit: a host that patched this out
// only cheats itself (it is paying for the seats). Real, un-bypassable enforcement is v2, server-side
// (the relay refuses the (seats+1)th bridge per account) — see docs/superpowers/specs Team Access.
//
// `seats` of 0 (free / no entitlement) always refuses — defence in depth behind the `isPremium` gate,
// which already blocks free users from hosting at all.
export function canAcceptSeat(liveCount: number, seats: number): boolean {
  return liveCount < seats
}
