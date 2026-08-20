import { describe, expect, it } from "vitest";

import { mergeVisibleSelection, pageCount, pageSlice, rowKey, selectAllState } from "./ReorderWorkbench";

// The workbench keeps ONE selection set across filter changes — the confirm dialog and the generate
// call both read every selected row, not just the visible ones. So the header checkbox must act on
// the visible rows without disturbing the rest; replacing the set was silently dropping rows the
// user had ticked under a previous filter.
const A = rowKey({ irmItemId: "i1", warehouseId: "W1" });
const B = rowKey({ irmItemId: "i2", warehouseId: "W2" });
const C = rowKey({ irmItemId: "i3", warehouseId: "W1" });

describe("mergeVisibleSelection", () => {
  it("adds the visible rows and KEEPS selections made under another filter", () => {
    // B was ticked while looking at Warehouse 2; now the user is filtered to Warehouse 1.
    const next = mergeVisibleSelection(new Set([B]), [A, C], false);
    expect([...next].sort()).toEqual([A, B, C].sort());
  });

  it("deselecting clears only the visible rows, never the off-filter ones", () => {
    const next = mergeVisibleSelection(new Set([A, B, C]), [A, C], true);
    expect([...next]).toEqual([B]);
  });

  it("is a no-op on the off-filter selection when nothing is visible", () => {
    expect([...mergeVisibleSelection(new Set([B]), [], false)]).toEqual([B]);
    expect([...mergeVisibleSelection(new Set([B]), [], true)]).toEqual([B]);
  });

  it("does not mutate the previous set", () => {
    const prev = new Set([B]);
    mergeVisibleSelection(prev, [A], false);
    expect([...prev]).toEqual([B]);
  });

  it("re-selecting an already-selected visible row is idempotent", () => {
    const next = mergeVisibleSelection(new Set([A, B]), [A], false);
    expect([...next].sort()).toEqual([A, B].sort());
  });
});

// ── Paging is a RENDERING concern here, and must stay one ──────────────────────────────────────
//
// The workbench raises purchase requests in bulk, so the dangerous version of this change is the
// obvious one: page the rows and let `selectableRows` / `chosen` follow the page. Rows ticked on
// page 1 would then drop out of `chosen`, and Generate would quietly raise fewer PRFs than the
// confirm dialog listed. `pageSlice` therefore only chooses what is DRAWN — every selection helper
// keeps reading the full filtered set.
describe("pageSlice", () => {
  const rows = Array.from({ length: 45 }, (_, i) => ({ id: i }));

  it("draws one page at a time", () => {
    expect(pageSlice(rows, 1, 20)).toHaveLength(20);
    expect(pageSlice(rows, 1, 20)[0]).toEqual({ id: 0 });
    expect(pageSlice(rows, 3, 20)).toEqual([{ id: 40 }, { id: 41 }, { id: 42 }, { id: 43 }, { id: 44 }]);
  });

  // Narrowing a filter while sitting on page 3 must not leave a blank table with no way back.
  it("clamps a page past the end onto the last one", () => {
    expect(pageSlice(rows, 99, 20)).toEqual(pageSlice(rows, 3, 20));
    expect(pageSlice([], 4, 20)).toEqual([]);
  });

  it("clamps a page below the first", () => {
    expect(pageSlice(rows, 0, 20)).toEqual(pageSlice(rows, 1, 20));
  });

  it("never drops a row across the pages", () => {
    const seen = [1, 2, 3].flatMap((p) => pageSlice(rows, p, 20));
    expect(seen).toEqual(rows);
  });
});

describe("pageCount", () => {
  it("counts the pages a list needs", () => {
    expect(pageCount(45, 20)).toBe(3);
    expect(pageCount(40, 20)).toBe(2);
  });

  // An empty list still has one page — Pagination renders "Total: 0" rather than "Page 1 of 0".
  it("is one page when there is nothing to show", () => {
    expect(pageCount(0, 20)).toBe(1);
  });
});

// ── The header checkbox must never look unchecked while ticked rows are on screen ──────────────
//
// It acts on the whole FILTERED set, not the page — one click still selects all 45 matching rows,
// which is the point of a bulk workbench. But once the table was paged, "all 20 rows I can see are
// ticked" no longer means "all selected", so a plain checked/unchecked box read as broken: every
// visible row ticked, header empty. The third state is what tells the truth.
describe("selectAllState", () => {
  it("is empty when nothing is selected", () => {
    expect(selectAllState(0, 45)).toBe("none");
  });

  it("is partial while some of the filtered rows are selected", () => {
    expect(selectAllState(20, 45)).toBe("some");
    expect(selectAllState(1, 45)).toBe("some");
    expect(selectAllState(44, 45)).toBe("some");
  });

  it("is full only when every selectable row is selected", () => {
    expect(selectAllState(45, 45)).toBe("all");
  });

  // Nothing orderable on screen (all covered, or no supplier) — the box has nothing to act on and
  // must not offer itself as "all selected".
  it("is empty when there is nothing selectable at all", () => {
    expect(selectAllState(0, 0)).toBe("none");
  });
});
