// Worklist item shape + priority comparator for "Awaiting Your Action".
// Pure and Prisma-free so it is unit-testable. Ordering (spec):
//   1. overdue  2. due today  3. high/urgent priority  4. oldest first.

export type WorklistKind =
  | "review_prf"
  | "approve_po_fastpath"
  | "review_po"
  | "send_po"
  | "acknowledge_po"
  | "receive_goods"
  | "review_kit_request"
  | "review_van_stock_request";

export interface WorklistItem {
  kind: WorklistKind;
  id: string;
  code: string;
  title: string | null;
  priority: string | null;
  dueDate: string | null; // ISO
  ageDays: number;
  href: string;
}

function startOfUTCDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Lower band = higher up the list. 0 overdue, 1 due-today, 2 high/urgent, 3 rest. */
function band(item: WorklistItem, now: Date): number {
  const today = startOfUTCDay(now);
  if (item.dueDate) {
    const due = startOfUTCDay(new Date(item.dueDate));
    if (due < today) return 0;
    if (due === today) return 1;
  }
  if (item.priority === "high" || item.priority === "urgent") return 2;
  return 3;
}

/** Comparator for Array.sort; pass `now` for determinism in tests. */
export function compareWorklist(a: WorklistItem, b: WorklistItem, now: Date): number {
  const ba = band(a, now);
  const bb = band(b, now);
  if (ba !== bb) return ba - bb;
  return b.ageDays - a.ageDays; // older first within a band
}
