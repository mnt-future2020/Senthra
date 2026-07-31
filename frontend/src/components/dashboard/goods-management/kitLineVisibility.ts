// Which of a job's kit lines are worth showing in THIS warehouse's Goods Management queue.
//
// The queue lists a job's FULL kit, deliberately — a warehouse manager should be able to see that a job
// also draws stock from elsewhere. But most lines of a multi-warehouse job are dead weight here: they
// render greyed out, nothing can be issued or returned against them, and eight rows of them bury the
// two the manager can actually act on. So the full kit stays available behind a toolbar control while
// the default view keeps only the actionable lines, and the job row reports how many were folded away —
// hidden, never silently dropped.
//
// `isLineActionable` MIRRORS the backend's per-line `hasWorkHere` check
// (goods-management.service.ts, step 2b) plus its van-return widening (step 2c). Keep the two in step:
// the backend guarantees every job it returns has at least one line that satisfies this predicate, so
// filtering by it can thin a job's rows but can never leave a job with none.

/** Only the fields the predicate reads, so a test needn't build a whole QueueKitLine. */
export interface VisibilityKitLine {
  lineType: string;
  plannedQty: number;
  issuedQty: number;
  warehouseId: string | null;
  vanReturnableQty: number;
}

/**
 * True when this line can be worked on at `warehouseId` right now:
 *   - a misc (free-text) line, until it is fully issued — it carries no warehouse, so ANY may hand it over
 *   - a real line homed at this warehouse
 *   - a real line homed elsewhere that still holds van-sourced stock, which owes no warehouse and so is
 *     returnable at any of them
 */
export function isLineActionable(line: VisibilityKitLine, warehouseId: string): boolean {
  if (line.lineType === "misc") return line.issuedQty < line.plannedQty;
  return line.warehouseId === warehouseId || line.vanReturnableQty > 0;
}

/**
 * The lines to render for one job, plus how many were folded away.
 *
 * `showAll` returns the kit untouched (hiddenCount 0). Otherwise only actionable lines survive — and if
 * that would empty the job entirely, the full kit is returned instead. That fallback should be
 * unreachable given the backend's guarantee above, but a job rendering zero rows would corrupt the
 * table's rowSpan grouping, so it degrades to "show everything" rather than to a broken row.
 */
export function visibleKitLines<T extends VisibilityKitLine>(
  lines: T[],
  warehouseId: string,
  showAll: boolean,
): { lines: T[]; hiddenCount: number } {
  if (showAll) return { lines, hiddenCount: 0 };
  const actionable = lines.filter((l) => isLineActionable(l, warehouseId));
  if (actionable.length === 0) return { lines, hiddenCount: 0 };
  return { lines: actionable, hiddenCount: lines.length - actionable.length };
}
