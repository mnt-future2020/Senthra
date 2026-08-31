import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── The wiring around the rental catalogue's row menu ──────────────────────────────────────────
//
// rentalRowActions.test.ts pins WHICH entries a row offers. This file pins how they are WIRED, which
// is where the expensive mistakes live: a status toggle that posts the row's whole snapshot back, a
// delete with no confirmation, a menu click that also navigates away.
//
// It reads the source rather than rendering it because this suite has no renderer — vitest runs in
// Node, jsdom is opt-in per file, and neither @testing-library/react nor jsdom is installed. Adding a
// component-testing stack to assert three call shapes is a bigger change than the feature. Source
// scanning is the established alternative here (see components/ui/multiSelectLabel.test.ts and
// components/dashboard/shell/Sidebar.nav.test.ts), and it catches exactly the regressions that matter:
// each assertion below names a specific way the change could be undone by an ordinary edit.

const DIR = join(process.cwd(), "src", "components", "dashboard", "rentals");
const listSrc = readFileSync(join(DIR, "RentalItemsView.tsx"), "utf8");
const detailSrc = readFileSync(join(DIR, "RentalItemDetail.tsx"), "utf8");

/** Comments BLANKED, not removed, so the prose below (which discusses these very call shapes by
 *  name) cannot satisfy an assertion about the code. Byte offsets are preserved either way. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const list = code(listSrc);

describe("RentalItemsView — actions column", () => {
  it("renders a row-actions menu in the table", () => {
    expect(list).toContain("<RentalRowActions");
    expect(list).toMatch(/showActions && \(\s*<td/);
    // Header and body must both be conditional on the same flag, or a viewer with neither
    // permission gets a header cell over nothing and every following column shifts by one.
    expect(list).toMatch(/showActions && <th/);
  });

  it("sizes the table for the extra column", () => {
    // Six entries, matching Code · Name · Category · Unit · Status · actions. A stale five-entry
    // array silently under-reserves width and puts the row-wrapping back.
    const widths = list.match(/tableMinWidth\(\[([\s\S]*?)\]\)/);
    expect(widths).not.toBeNull();
    expect(widths![1].split(",").length).toBe(6);
  });

  it("derives visibility from the two EXISTING rental permissions and no others", () => {
    expect(list).toContain('can("rentals.edit")');
    expect(list).toContain('can("rentals.delete")');
    // No rentals.activate / rentals.deactivate / rentals.manage was invented for the toggle.
    const perms = [...list.matchAll(/can\("([^"]+)"\)/g)].map((m) => m[1]).sort();
    expect(perms).toEqual(["rentals.create", "rentals.delete", "rentals.edit", "rentals.export"]);
  });
});

describe("RentalItemsView — activate / deactivate", () => {
  it("sends a STATUS-ONLY patch", () => {
    // The row in `items` is a snapshot from the last fetch. Sending its other fields back would let
    // this control silently revert a name or category someone else changed since the page loaded.
    expect(list).toContain("updateRentalItem(item.id, { status: next })");
    const call = list.match(/updateRentalItem\([^)]*\)/);
    expect(call![0]).not.toMatch(/name|baseUnit|rentalCategoryId|notes|description/);
  });

  it("uses the shared next-status rule rather than an inline flip", () => {
    expect(list).toContain("nextRentalStatus(item.status)");
  });

  it("refetches the list after the mutation so the badge and the label cannot go stale", () => {
    expect(list).toContain("setRefreshKey((k) => k + 1)");
    // The list effect keys on the filters, which a status change does not touch — so refreshKey has
    // to be in its dependency array or the refetch never fires.
    const deps = list.match(/\}, \[search, status, categoryId, page[^\]]*\]/);
    expect(deps).not.toBeNull();
    expect(deps![0]).toContain("refreshKey");
  });

  it("keeps both statuses reachable from the toolbar filter", () => {
    expect(list).toContain('label: "Active"');
    expect(list).toContain('label: "Inactive"');
  });
});

describe("RentalItemsView — delete", () => {
  it("goes through the shared confirmation dialog, never straight from the menu", () => {
    expect(list).toContain("<ConfirmDialog");
    // The menu entry only OPENS the dialog; the delete call belongs to the dialog's onConfirm.
    expect(list).toContain("onDelete={() => setConfirm({ open: true, item })}");
    expect(list).toContain("onConfirm={onDelete}");
  });

  it("names the item and its code in the confirmation", () => {
    expect(list).toContain("{confirm.item?.name}");
    expect(list).toContain("{confirm.item?.code}");
  });

  it("surfaces the server's own refusal instead of a generic failure", () => {
    // The 409 from DELETE_DEPENDENCY_CHECKERS names WHICH dependency blocks it — purchase requests,
    // purchase orders, job kit lists or engineer-held hires. Swallowing that for a fixed string is
    // how a user is told "Delete failed" and has nothing to act on.
    expect(list).toMatch(/e instanceof Error \? e\.message : "Delete failed\."/);
  });

  it("carries no client-side copy of the backend's dependency rule", () => {
    // A mirrored guard here is a second copy to keep in step with the server's checker list, and the
    // copy that drifts is always the one that lets a delete through.
    expect(list).not.toMatch(/purchaseOrderCount|hireCount|canBeDeleted|isDeletable/);
  });
});

describe("RentalItemsView — row click and keyboard", () => {
  it("stops the actions cell from triggering row navigation", () => {
    // On the CELL, not just the trigger: the row navigates on click, so a press landing on the
    // cell's padding would open the item underneath the action being taken.
    expect(list).toMatch(/<td className="cell-y px-4" onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(list).toMatch(/onClick=\{\(e\) => \{\s*e\.stopPropagation\(\);/);
  });

  it("exposes the menu to assistive tech and to the keyboard", () => {
    expect(list).toContain('aria-haspopup="menu"');
    expect(list).toContain("aria-expanded={open}");
    expect(list).toContain('role="menu"');
    expect(list).toContain('role="menuitem"');
    expect(list).toContain('e.key === "Escape"');
    // Focus moves into the menu on open and back to the trigger on close — without the second half
    // a keyboard user is dropped at the top of the document after every action.
    expect(list).toContain('menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus()');
    expect(list).toContain("btnRef.current?.focus()");
  });

  it("portals the menu so the table's own overflow cannot clip it", () => {
    expect(list).toContain("createPortal(");
    expect(list).toContain("document.body");
  });
});

describe("RentalItemDetail — unchanged", () => {
  it("still offers Edit and Delete with the same permissions and the same call", () => {
    expect(detailSrc).toContain('can("rentals.edit")');
    expect(detailSrc).toContain('can("rentals.delete")');
    expect(detailSrc).toContain("deleteRentalItem(item.id)");
    expect(detailSrc).toContain("<ConfirmDialog");
  });

  it("uses the same delete endpoint as the list, so the two cannot diverge", () => {
    const fn = "deleteRentalItem";
    expect(code(detailSrc)).toContain(`rentalService.${fn}(`);
    expect(list).toContain(`rentalService.${fn}(`);
  });
});
