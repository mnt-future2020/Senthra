import type { JobKitLine, KitRequestLine } from "../types";

// Kit-line presentation helpers ported from the web dashboard's
// components/dashboard/jobs/jobStatus.tsx so both surfaces show identical
// source/return breakdowns.

export const LINE_TYPE_LABEL: Record<string, string> = {
  customer_stock: "Customer stock",
  irm: "IRM",
  misc: "Misc",
};

export const GOODS_STATUS_LABELS: Record<string, string> = {
  not_issued: "Not issued",
  partially_issued: "Partial",
  issued: "Issued",
  awaiting_return: "Awaiting return",
  reconciled: "Reconciled",
};

// A kit line MERGES sources: the same item at the same warehouse is one row, so
// units collected from the warehouse and units handed over from another
// engineer's van end up on a single line. `vanOnly` also decides where leftovers
// may go back: IRM van stock never left a warehouse, so it can be returned
// anywhere; consignment is warehouse-only, so its van share is NOT returnable
// elsewhere and a line with ANY warehouse-issued qty still owes that part to
// its own warehouse.
export interface KitLineSourceSplit {
  warehouseQty: number; // issued from this line's own warehouse
  vanQty: number; // handed over from a van (transfer completed)
  pendingVanQty: number; // agreed but not yet handed over
  vanReturnableQty: number; // van share returnable at any warehouse — IRM only
  outstandingWarehouseQty: number; // still to collect from the warehouse (0 once the job is cancelled)
  warehouseShare: number; // the warehouse's total share: issued from it + still to collect
  vanOnly: boolean;
}

export function kitLineSourceSplit(
  line: JobKitLine,
  opts: { jobCancelled?: boolean } = {},
): KitLineSourceSplit {
  const sources = line.vanSources ?? [];
  const sum = (status: string) =>
    sources.filter((v) => v.status === status).reduce((n, v) => n + v.quantity, 0);
  const vanQty = sum("completed");
  const pendingVanQty = sum("pending");
  // Whatever the van didn't supply came from the warehouse. Clamped: a return
  // posted at another warehouse can push `issued` below `vanQty`.
  const warehouseQty = Math.max(0, line.issued - vanQty);
  const vanReturnableQty = line.lineType === "irm" ? vanQty : 0;
  const outstandingWarehouseQty = opts.jobCancelled
    ? 0
    : Math.max(0, line.qty - line.issued - pendingVanQty);
  return {
    vanQty,
    pendingVanQty,
    warehouseQty,
    vanReturnableQty,
    outstandingWarehouseQty,
    warehouseShare: warehouseQty + outstandingWarehouseQty,
    vanOnly: line.issued > 0 && vanReturnableQty >= line.issued,
  };
}

/** Where leftovers of a van-sourced line may be returned (shown under van sources). */
export function returnLocationNote(line: JobKitLine, split: KitLineSourceSplit): string {
  if (split.vanOnly) return "Return at any warehouse";
  if (split.vanReturnableQty > 0 && split.warehouseQty > 0 && line.warehouseName) {
    return `Return ×${split.warehouseQty} at ${line.warehouseName}, ×${split.vanReturnableQty} at any warehouse`;
  }
  if (line.warehouseName) return `Return at ${line.warehouseName}`;
  return "";
}

/** Stock-tracked units the engineer still holds — drives the cancelled-job return advisory. */
export function outstandingKit(kitLines: JobKitLine[]): { units: number; items: number } {
  const held = kitLines.filter((l) => l.lineType !== "misc" && l.remaining > 0);
  return { units: held.reduce((n, l) => n + l.remaining, 0), items: held.length };
}

/**
 * What the reviewer granted on a kit-request line: approvedQty null = in full
 * (and every pre-trim row), 0 = excluded, N < qty = trimmed.
 */
export function kitLineOutcome(l: KitRequestLine): { qty: number; excluded: boolean; trimmed: boolean } {
  if (l.approvedQty == null) return { qty: l.qty, excluded: false, trimmed: false };
  return { qty: l.approvedQty, excluded: l.approvedQty === 0, trimmed: l.approvedQty < l.qty };
}

// When Returned exceeds Issued (a return posted at a different warehouse than the
// one that issued), explain the surplus and name the sibling source warehouse(s).
export function crossWarehouseReturnNote(line: JobKitLine, lines: JobKitLine[]): string | null {
  const excess = line.returned - line.issued;
  if (excess <= 0) return null;
  const sources = lines.filter(
    (l) =>
      l.id !== line.id &&
      ((line.irmItemId && l.irmItemId === line.irmItemId) ||
        (line.customerStockEntryId && l.customerStockEntryId === line.customerStockEntryId)) &&
      l.issued - l.returned > 0,
  );
  const names = [...new Set(sources.map((l) => l.warehouseName).filter((n): n is string => !!n))];
  return `+${excess} from ${names.length ? names.join(", ") : "another warehouse"}`;
}
