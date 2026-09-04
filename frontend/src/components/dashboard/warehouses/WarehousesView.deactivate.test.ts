import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The warehouse deactivate confirmation, on BOTH surfaces ────────────────────────────────────
//
// warehouseDeactivate.test.ts pins what the dialog SAYS. This file pins that it is actually in the
// path — on the list row menu and on the detail header, which are two separate copies of the same
// decision and therefore two separate chances to drift.
//
// The count must keep coming from the attention row the screen already renders. If a later edit
// swaps it for a locally computed figure, the dialog and the "Needs attention here" column start
// disagreeing about the same warehouse on the same screen, and neither is obviously the wrong one.
//
// Source-scanned, not rendered: see the note in rentals/RentalItemsView.actions.test.ts.

const DIR = join(process.cwd(), "src", "components", "dashboard", "warehouses");
const blank = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length)).replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

const list = blank(readFileSync(join(DIR, "WarehousesView.tsx"), "utf8"));
const detail = blank(readFileSync(join(DIR, "WarehouseDetail.tsx"), "utf8"));

describe.each([
  ["list", list],
  ["detail", detail],
])("warehouse deactivate — %s surface", (_name, code) => {
  it("confirms before deactivating and not before activating", () => {
    expect(code).toMatch(/if \(w\.status === "active"\) \{/);
    expect(code).toContain('applyStatus');
    expect(code).toMatch(/applyStatus\((?:w, )?"active"\)/);
  });

  it("patches status from exactly one place", () => {
    const calls = [...code.matchAll(/warehouseService\.updateWarehouse\(/g)];
    expect(calls.length).toBe(1);
    // Still a STATUS-ONLY patch — never the row's stale snapshot posted back.
    expect(code).toMatch(/updateWarehouse\(w\.id, \{ status: next \}\)/);
  });

  it("takes its count from the shared attention row, not a new definition", () => {
    expect(code).toContain("warehouseDeactivateDetail(");
    expect(code).toContain('useEntityAttention("warehouse")');
    // No second source of truth invented for the dialog.
    expect(code).not.toMatch(/getEntityAttention\(/);
  });

  it("is not painted as a destructive action", () => {
    // Deactivating is reversible from the same control. `danger` is the delete colour and would say
    // otherwise — the dialog informs, it does not warn. The WHOLE element is checked, props before
    // the title included; slicing forward from the title silently exempts half of them.
    // Terminator is a `/>` alone on its own line: a bare `?\/>` stops at the `</>` that closes the
    // message fragment, and the block would end before the props being asserted on.
    const dialogs = [...code.matchAll(/<ConfirmDialog[\s\S]*?\n\s*\/>/g)].map((m) => m[0]);
    const deactivate = dialogs.filter((d) => d.includes('title="Deactivate warehouse"'));
    expect(deactivate.length).toBe(1);
    // Proves the block was actually captured, so the negative below cannot pass on an empty string.
    expect(deactivate[0]).toContain('confirmLabel="Deactivate"');
    expect(deactivate[0]).not.toMatch(/^\s*danger\s*$/m);
  });

  it("dismissal cannot mutate", () => {
    expect(code).toMatch(/onClose=\{\(\) => set(StatusConfirm|ConfirmDeactivate)\(/);
    expect(code).not.toMatch(/onClose=\{[^}]*onConfirmDeactivate/);
  });

  it("cannot double-submit", () => {
    expect(code).toMatch(/busy=\{(deactivating|busy)\}/);
    expect(code).toMatch(/if \([^)]*(deactivating|busy)\) return;/);
  });

  it("keeps the existing toast and error handling", () => {
    expect(code).toContain('pushToast(next === "inactive" ? "Warehouse deactivated." : "Warehouse activated.", "success")');
    expect(code).toContain('"Could not update the warehouse."');
  });

  it("adds no new permission for the confirmation", () => {
    const perms = [...code.matchAll(/can\("(warehouse[^"]*)"\)/g)].map((m) => m[1]);
    for (const p of perms) expect(["warehouse.edit", "warehouse.delete", "warehouse.create", "warehouse.export"]).toContain(p);
  });
});

describe("warehouse deactivate — the two surfaces share their copy", () => {
  it("neither surface inlines the consequence sentence", () => {
    // One string, one file. An inlined copy is one that gets reworded on the list and left stale on
    // the detail page, and nobody notices because you only ever see one of them at a time.
    for (const code of [list, detail]) {
      expect(code).not.toContain("will be blocked until it is reactivated");
      expect(code).not.toContain("can still be received");
      expect(code).toContain('from "./warehouseDeactivate"');
    }
  });
});
