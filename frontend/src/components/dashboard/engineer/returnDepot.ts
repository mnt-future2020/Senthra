/**
 * WHERE A FIELD STOCK RETURN GOES BACK — decided from the cart, not asked of the engineer.
 *
 * A hire belongs to the warehouse of its purchase order, and the domain model has nowhere to record
 * "this hire came back somewhere else": custody rows carry no warehouse, the hire's counters are global
 * to the hire, and a depot's rental stock is DERIVED by summing hires whose order warehouse is that
 * depot. Hand a tester back at the wrong counter and the origin depot's figure silently rises for a box
 * that is not there. So the server refuses it — at create, at scan, and inside the posting transaction.
 *
 * That rule is right; asking the engineer to guess it was not. The return form used to offer every
 * active warehouse, let an invalid one be chosen, and only refuse after the whole form was filled in.
 * The correct depot is already known the moment a hired row enters the cart, so this decides it.
 *
 * COMPANY STOCK IS UNAFFECTED. An IRM balance exists per (item, warehouse), so a cable can go back to
 * any warehouse and that warehouse's balance is credited. An IRM-only cart keeps the free picker it has
 * always had; IRM added alongside a hire simply travels to the hire's depot, which is a place it can
 * legitimately be booked in.
 */

/** The depot facts a cart row carries. Only hired rows have any; company stock has no source depot. */
export interface DepotBearingLine {
  source: string;
  /**
   * Field-origin depots for this row, from the hire's own order warehouse. Absent or empty on company
   * stock, which has no source depot — optional so a cart row and a holdings row both satisfy this.
   *
   * `qty` is how many of this row's units are at that depot. A row's own `quantityOnHand` is a ROLL-UP
   * across them, and one return carries one warehouse, so the roll-up is not a postable number for a
   * row that spans two — see `unitsAtDepot`.
   */
  depots?: readonly { warehouseId: string; warehouseName: string; qty: number }[];
}

export type ReturnDepot =
  /** No hired kit in the cart — the engineer picks freely, exactly as before. */
  | { kind: "free" }
  /** Every hired row agrees on one depot. That IS the destination; there is nothing to choose. */
  | { kind: "fixed"; warehouseId: string; warehouseName: string }
  /**
   * Hired rows share more than one candidate depot — possible when a single catalogue row spans hires
   * at several depots. Still a choice, but only between these; anything else is refused server-side.
   */
  | { kind: "restricted"; options: readonly { warehouseId: string; warehouseName: string }[] }
  /**
   * A hired row carries no resolvable depot. Never guess: without the depot there is no way to know
   * which counter can take it, and picking one would produce a request the posting must refuse.
   */
  | { kind: "unknown" };

const isRental = (l: DepotBearingLine) => l.source === "rental";

/**
 * The depots every hired row in the cart can agree on — the INTERSECTION, because one return has one
 * destination and each hired row must be returnable there.
 */
function commonDepots(cart: readonly DepotBearingLine[]): { warehouseId: string; warehouseName: string }[] | null {
  const rentals = cart.filter(isRental);
  if (rentals.length === 0) return [];
  let common: { warehouseId: string; warehouseName: string }[] | null = null;
  for (const line of rentals) {
    const depots = line.depots ?? [];
    if (depots.length === 0) return null; // unresolved depot — see `unknown`
    if (common === null) {
      common = [...depots];
      continue;
    }
    const here = new Set(depots.map((d) => d.warehouseId));
    common = common.filter((d) => here.has(d.warehouseId));
  }
  return common ?? [];
}

/** What the return-warehouse control should do for this cart. */
export function returnDepotFor(cart: readonly DepotBearingLine[]): ReturnDepot {
  if (!cart.some(isRental)) return { kind: "free" };
  const common = commonDepots(cart);
  if (common === null) return { kind: "unknown" };
  // Empty intersection cannot normally be reached — `canAddRental` refuses the add that would create
  // it — but a cart restored from an older state could still hold one, and silently picking a depot
  // would build a request the server must reject.
  if (common.length === 0) return { kind: "unknown" };
  if (common.length === 1) return { kind: "fixed", ...common[0] };
  return { kind: "restricted", options: common };
}

/**
 * May this hired row join the cart?
 *
 * One return request carries ONE warehouse — the returns leg deliberately does not split per line the
 * way a restock does — so two hires that must go back to different depots cannot travel together. The
 * server already refuses such a cart at create; refusing the ADD is what stops the engineer filling in
 * a form that was doomed from the moment the second row went in.
 */
export function canAddRental(
  cart: readonly DepotBearingLine[],
  candidate: DepotBearingLine,
): { ok: true } | { ok: false; reason: string } {
  if (!isRental(candidate)) return { ok: true };
  const candidateDepots = candidate.depots ?? [];
  if (candidateDepots.length === 0) {
    return {
      ok: false,
      reason: "We couldn't work out which depot this hire came from. Refresh and try again, or ask the office to check the order.",
    };
  }
  const current = commonDepots(cart);
  if (current === null) return { ok: true }; // an unresolved row is already blocking submission
  if (current.length === 0) return { ok: true }; // no hired kit yet — this row sets the depot
  const candidateIds = new Set(candidateDepots.map((d) => d.warehouseId));
  if (current.some((d) => candidateIds.has(d.warehouseId))) return { ok: true };
  // Name the depot the engineer must drive to, and say what to do instead. Never an id.
  const where = candidateDepots.map((d) => d.warehouseName).join(" or ");
  return {
    ok: false,
    reason: `This item was collected from ${where}. Create a separate return for that depot.`,
  };
}

/**
 * HOW MANY OF THIS ROW MAY ACTUALLY GO BACK TO THE CHOSEN DEPOT.
 *
 * A hired row's quantity is summed across every hire the units sit on, and those hires can belong to
 * different depots — 2 collected from Bristol and 3 from Leeds is one row of 5. One return request
 * carries ONE warehouse, so 5 is a number that can be posted to neither counter: the composer offered
 * it, the engineer filled the form in, and the server refused at create. Nothing on the screen said to
 * split it, and nothing could, because the roll-up had thrown the split away.
 *
 * `null` means "no narrower ceiling than the row's own" — company stock, a row at a single depot (where
 * the roll-up already IS that depot's holding), or a depot the row does not name. The caller takes the
 * MINIMUM of this and the row's own figure, so this can only ever tighten a cap, never widen one, and
 * the server's per-depot guards stay the authority on the exact number.
 */
export function unitsAtDepot(line: DepotBearingLine, warehouseId: string): number | null {
  if (!isRental(line)) return null;
  const depots = line.depots ?? [];
  if (depots.length <= 1 || !warehouseId) return null;
  const at = depots.find((d) => d.warehouseId === warehouseId);
  return at ? at.qty : null;
}

/** Why the picker cannot accept a row: its depot clashes with the cart, or it has none to check. */
export type RowRefusal = "other-depot" | "unknown-depot";

/**
 * The rows this cart cannot accept, and why — one verdict per row, so the picker can say it ON the row.
 *
 * `canAddRental` answers for one candidate at the moment it is tapped; a list needs the same answer for
 * every row BEFORE anything is tapped, because a refusal the engineer only meets after tapping is a
 * refusal they have to go looking for. Rows already in the cart are skipped: they are spoken for, and
 * "already added" is the more useful thing to say about them.
 */
export function refusedRentalRows<T extends DepotBearingLine>(
  cart: readonly DepotBearingLine[],
  rows: readonly T[],
  keyOf: (row: T) => string,
  isInCart: (key: string) => boolean,
): Map<string, RowRefusal> {
  const refused = new Map<string, RowRefusal>();
  for (const row of rows) {
    if (!isRental(row)) continue;
    const key = keyOf(row);
    if (isInCart(key)) continue;
    if (canAddRental(cart, row).ok) continue;
    // Which refusal it is decides WHERE the reason can be shown: a row that names its depot can carry
    // the consequence on that same line, one that names none needs a line of its own.
    refused.set(key, (row.depots ?? []).length > 0 ? "other-depot" : "unknown-depot");
  }
  return refused;
}

/** A picker entry, in the shape `Select` already takes. */
export interface DepotOption {
  value: string;
  label: string;
}

/**
 * WHAT THE RETURN-WAREHOUSE PICKER MAY OFFER.
 *
 * `unknown` offers NOTHING, and that is the whole point of it existing. It used to fall in with `free`
 * and hand back every active warehouse — the one thing this control must never do, because the cart
 * holds a hire whose depot could not be resolved and every option in that list is therefore a guess.
 * The submit guard did not catch it either: it tested for an empty string, and a guess is not empty.
 *
 * `fallback` names the depot(s) from the hire itself, for a warehouse the list does not carry —
 * inactive, or simply not loaded yet — so a valid destination is never hidden by a stale list.
 */
export function returnWarehouseOptions(depot: ReturnDepot, all: readonly DepotOption[]): DepotOption[] {
  if (depot.kind === "unknown") return [];
  if (depot.kind === "free") return [...all];
  const allowed = new Set(depot.kind === "fixed" ? [depot.warehouseId] : depot.options.map((d) => d.warehouseId));
  const narrowed = all.filter((o) => allowed.has(o.value));
  if (narrowed.length > 0) return narrowed;
  return depot.kind === "fixed"
    ? [{ value: depot.warehouseId, label: depot.warehouseName }]
    : depot.options.map((d) => ({ value: d.warehouseId, label: d.warehouseName }));
}

/**
 * THE DESTINATION THIS RETURN WILL ACTUALLY BE CREATED WITH — derived from the cart, never stored.
 *
 * Deriving is what lets removing the last hire hand the field straight back to a normal picker with no
 * stale value to clear, and leaves no second source of truth for the submit to disagree with.
 *
 * An empty string means THERE IS NO VALID DESTINATION, which is what the submit guard tests. `unknown`
 * must therefore resolve to one: passing the raw pick through made that guard a no-op and sent a
 * request the server could only refuse.
 */
export function effectiveReturnWarehouse(depot: ReturnDepot, picked: string): string {
  if (depot.kind === "fixed") return depot.warehouseId;
  if (depot.kind === "restricted") return depot.options.some((d) => d.warehouseId === picked) ? picked : "";
  if (depot.kind === "unknown") return "";
  return picked;
}
