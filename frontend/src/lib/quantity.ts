// Shared numeric-input helpers for quantity fields that have a hard upper bound (stock you actually
// hold). Clamping AS THE USER TYPES is the pattern the van-request and job-scan panels already use:
// an impossible number never sits in the field waiting to be refused on submit, which also means the
// form never has to explain a rejection it could have prevented.

/**
 * Next value for a bounded quantity box, clamped to 1..max.
 *
 * Returns:
 *   - `""`   for a deliberately cleared field, so it can be retyped mid-edit
 *   - `null` when the keystroke should be IGNORED entirely — a number input still admits a lone "-"
 *     or "e", and those must not wipe what has already been typed
 *   - otherwise the clamped value as a string
 *
 * A `max` below 1 leaves NOTHING to clamp to (1..0 is an empty range), so the typed number passes
 * through instead — see the comment on that branch.
 */
export function clampQuantityInput(raw: string, max: number): string | null {
  if (raw === "") return "";
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n)) return null;
  // Nothing available. Clamping into an empty range can only ever produce "0", which rewrites every
  // keystroke and leaves the field looking frozen: the submit gate blocks 0, and a caller's
  // "more than available" warning is `qty > available`, which 0 > 0 never satisfies — so the form
  // refuses to move and explains nothing. Let the typed number stand and let the caller say why it
  // can't be used. Still floored at 0 so a stray "-5" can't sit in the box.
  if (max < 1) return String(Math.max(0, n));
  return String(Math.min(max, Math.max(1, n)));
}
