import { describe, expect, it } from "vitest";

import { mergeVisibleSelection, rowKey } from "./ReorderWorkbench";

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
