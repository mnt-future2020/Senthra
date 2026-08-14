// Both branches below phrase a pack count, and they each pluralised it on their own — one of them
// said "1 full packs". One place to get it right.
const packs = (n: number) => `${n} ${n === 1 ? "pack" : "packs"}`;

/**
 * The pack-size advisory under a purchase-request line's Quantity box.
 *
 * A REORDER-generated request already arrives in whole packs — the reorder engine rounds its
 * suggestion up (inventory/reorder.ts). A hand-typed one doesn't, and nothing on the form said the
 * item came in packs at all, so "380 metres" of a 305m-box cable could reach the supplier before
 * anyone noticed it wasn't orderable.
 *
 * Advisory only, never a block: buying a part-pack is a legitimate decision (a top-up, a sample, a
 * one-off). This exists so it can't be an ACCIDENTAL one.
 *
 * Returns null when there is nothing worth saying — no pack size, or a pack of 1, which is what
 * "sold individually" looks like in the data and would otherwise put a pointless note on every line.
 */
export function packHint(packSize: number | null | undefined, quantity: string): string | null {
  if (!packSize || !Number.isFinite(packSize) || packSize <= 1) return null;

  const qty = Number(quantity);
  // Nothing typed yet (or not a usable number) — still worth saying how the item is sold.
  if (!quantity.trim() || !Number.isFinite(qty) || qty <= 0) return `Sold in packs of ${packSize}.`;

  if (Number.isInteger(qty) && qty % packSize === 0) return `${packs(qty / packSize)} of ${packSize}.`;

  // The useful case: name the next whole pack up, which is the figure the reorder engine would have
  // produced and the one the supplier can actually fill.
  const rounded = Math.ceil(qty / packSize) * packSize;
  return `Packs of ${packSize} — ${rounded} would be ${packs(rounded / packSize)}.`;
}
