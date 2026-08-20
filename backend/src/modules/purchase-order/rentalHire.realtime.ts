import { RENTAL_WATCHERS_ROOM, emitAttentionChanged, emitToRoom } from "../../lib/realtime.js";

/**
 * Fan a hire's change out to every rental watcher, so screens left open stop lying.
 *
 * A hire passes through more hands than most records and they are rarely in the same building: a PM
 * raises the order, a warehouse books the kit in, someone on a site reports it broken, the warehouse
 * hands it back. Every one of those surfaces is a list somebody leaves open — the on-hire board, the
 * warehouse's receiving pane, the order's own page — and each of them is exactly the kind of screen
 * where a stale row becomes a second delivery record for kit that is already booked in.
 *
 * The payload is a scope-agnostic REFETCH SIGNAL, not the hire: every client re-pulls through its own
 * warehouse-scoped REST call, so the shared room can never leak a hire outside a watcher's scope. A
 * watcher whose scope excludes it just does one harmless no-op refetch.
 *
 * Fire-and-forget, and it MUST stay that way — `emitToRoom` is a no-op when realtime is uninitialised
 * (unit tests, the CLI), and a realtime failure can never roll back a committed movement.
 */
export function emitHireUpdated(purchaseOrderId: string, code: string): void {
  emitToRoom(RENTAL_WATCHERS_ROOM, "rental_hire:updated", { purchaseOrderId, code });
  // Every hire movement moves a queue: receiving takes a line off `wh.rental_intake`, a return takes
  // it off the deadline badges, an extension moves the date they fire on. The badges refresh on the
  // same signal the surfaces do, so a cleared queue and a cleared badge cannot disagree.
  emitAttentionChanged("rentals");
}
