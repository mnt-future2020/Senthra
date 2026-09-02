// Field-level change diffing for procurement documents (Purchase Request + Purchase Order).
//
// A draft PRF/PO is freely editable until it's submitted, and the header/lines lock once it moves
// on. To make edits auditable the way Zoho/SAP/NetSuite do — "who changed the price from X to Y" —
// the update path records a compact before→after list in the audit entry's metadata. This module is
// the pure diff that produces that list; the services call it and attach the result. Kept pure and
// framework-free so it's unit-testable and shared identically by both modules (same money maths, so
// the same audit shape).
//
// SCOPE: only the COMMERCIALLY-meaningful fields are diffed — supplier, delivery warehouse, and each
// line's quantity / unit price / VAT rate, plus whole-line add/remove. Non-financial header fields
// (project ref, notes, justification, dates) are intentionally excluded: the goal is a fraud/mistake
// trail on money and sourcing, not a full field-by-field version history.
//
// PRESENTATION: every change carries a ready-to-display `label` (e.g. "Fibre — Unit price: £1.85 →
// £2.01") AND money-formatted from/to strings, so both the audit-entry drawer and any inline audit
// list render it as-is with no downstream formatting — prices are pounds, never raw pence.

// The subset of a procurement line the diff inspects. Both the loaded record's lines and the freshly
// built line rows expose these (extra fields are ignored).
export interface ProcurementLineLike {
  /**
   * Stable identity for the line, used to pair a before with an after.
   *
   * For an IRM line this is the item id — a procurement line is unique per item on both documents
   * (DB-enforced). A RENTAL line is not: the same item may appear again with a different hire
   * period or delivery address, so it supplies the same composite the compound unique index uses.
   * Hence a neutral name rather than `irmItemId`.
   */
  lineKey: string;
  itemName: string;
  quantity: number;
  unitPricePence: number;
  vatRate: number;
}

// The subset of a procurement document the diff inspects.
export interface ProcurementDocLike {
  supplierId: string;
  supplierName: string | null;
  warehouseId: string;
  items: ProcurementLineLike[];
}

// The incoming (post-update) view. `items` is optional: a header-only PATCH doesn't resend lines, so
// `undefined` means "lines were not part of this update" and line diffing is skipped entirely.
export interface ProcurementUpdateLike {
  supplierId: string;
  supplierName: string | null;
  warehouseId: string;
  items?: ProcurementLineLike[];
}

// One recorded change. `item` scopes line-level entries to their item name. `from`/`to` are already
// display-formatted (pounds for prices, "N%" for VAT). `label` is a full ready-to-render sentence.
export interface ProcurementChange {
  field:
    | "supplier"
    | "warehouse"
    | "line.quantity"
    | "line.unitPrice"
    | "line.vatRate"
    | "line.added"
    | "line.removed";
  item?: string;
  from: string | number | null;
  to: string | number | null;
  label: string;
}

// Integer pence → "£1.85". Kept local so the audit shape never leaks raw pence to a reader.
const gbp = (pence: number): string =>
  `£${(pence / 100).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// A whole line's financials as a one-line human summary, e.g. "2 × £68.00 (VAT 20%)".
const lineSummary = (l: ProcurementLineLike): string => `${l.quantity} × ${gbp(l.unitPricePence)} (VAT ${l.vatRate}%)`;

/**
 * Diff the commercially-meaningful fields of a procurement document. Returns an ordered list of
 * {field, from, to, label} changes (empty when nothing financial changed). Lines are matched by
 * `lineKey` — unique per line on both documents (DB-enforced for IRM lines, composite for hires) — so a keyed
 * comparison is a faithful match. When `incoming.items` is undefined the update didn't touch lines,
 * so only the header (supplier/warehouse) is compared.
 */
export function diffProcurementChanges(existing: ProcurementDocLike, incoming: ProcurementUpdateLike): ProcurementChange[] {
  const changes: ProcurementChange[] = [];

  // ── Header ──────────────────────────────────────────────────────────────────────────────────
  if (incoming.supplierId !== existing.supplierId) {
    // Prefer the human name; fall back to the id if a name isn't available on either side.
    const from = existing.supplierName ?? existing.supplierId;
    const to = incoming.supplierName ?? incoming.supplierId;
    changes.push({ field: "supplier", from, to, label: `Supplier: ${from} → ${to}` });
  }
  if (incoming.warehouseId !== existing.warehouseId) {
    // Warehouse names aren't on the diff input (ids only) — a generic label reads better than raw ids.
    changes.push({ field: "warehouse", from: existing.warehouseId, to: incoming.warehouseId, label: "Delivery warehouse changed" });
  }

  // ── Lines ───────────────────────────────────────────────────────────────────────────────────
  // Only when the update actually carried lines. A header-only patch leaves them untouched.
  if (incoming.items !== undefined) {
    const existingByItem = new Map(existing.items.map((l) => [l.lineKey, l]));
    const incomingByItem = new Map(incoming.items.map((l) => [l.lineKey, l]));

    // Changed + added — iterate the incoming set (preserves the caller's line order).
    for (const inc of incoming.items) {
      const prev = existingByItem.get(inc.lineKey);
      if (!prev) {
        changes.push({ field: "line.added", item: inc.itemName, from: null, to: lineSummary(inc), label: `Line added: ${inc.itemName} — ${lineSummary(inc)}` });
        continue;
      }
      if (prev.quantity !== inc.quantity) {
        changes.push({ field: "line.quantity", item: inc.itemName, from: prev.quantity, to: inc.quantity, label: `${inc.itemName} — Quantity: ${prev.quantity} → ${inc.quantity}` });
      }
      if (prev.unitPricePence !== inc.unitPricePence) {
        const from = gbp(prev.unitPricePence);
        const to = gbp(inc.unitPricePence);
        changes.push({ field: "line.unitPrice", item: inc.itemName, from, to, label: `${inc.itemName} — Unit price: ${from} → ${to}` });
      }
      if (prev.vatRate !== inc.vatRate) {
        changes.push({ field: "line.vatRate", item: inc.itemName, from: `${prev.vatRate}%`, to: `${inc.vatRate}%`, label: `${inc.itemName} — VAT: ${prev.vatRate}% → ${inc.vatRate}%` });
      }
    }

    // Removed — in existing but not incoming.
    for (const prev of existing.items) {
      if (!incomingByItem.has(prev.lineKey)) {
        changes.push({ field: "line.removed", item: prev.itemName, from: lineSummary(prev), to: null, label: `Line removed: ${prev.itemName} — ${lineSummary(prev)}` });
      }
    }
  }

  return changes;
}

/**
 * Both kinds of line, in the shape the diff pairs them by.
 *
 * IRM lines are keyed by item — unique per document. A RENTAL line is not: the same item may appear
 * again with a different period or address, so it is keyed by the same composite the request's
 * compound unique index uses. Hires are labelled "(hire)" so an entry reads unambiguously and an IRM
 * item sharing a name cannot be mistaken for one.
 *
 * Shared by the request's and the order's update paths — a hire's quantity or price changing before
 * approval is exactly the kind of edit this trail exists to record, and either document leaving its
 * rental lines out of the diff made every such change invisible.
 */
export function procurementDiffLines(
  items: { irmItemId: string; itemName: string; quantity: number; unitPricePence: number; vatRate: number }[],
  rentals: {
    rentalItemId: string;
    itemName: string;
    hireStartDate: Date | string;
    hireEndDate: Date | string;
    deliveryAddress: string | null;
    quantity: number;
    unitPricePence: number;
    vatRate: number;
  }[],
): ProcurementLineLike[] {
  return [
    ...items.map((i) => ({ ...i, lineKey: i.irmItemId })),
    ...rentals.map((r) => ({
      ...r,
      itemName: `${r.itemName} (hire)`,
      lineKey: [r.rentalItemId, String(r.hireStartDate), String(r.hireEndDate), r.deliveryAddress ?? ""].join("|"),
    })),
  ];
}
