import { describe, expect, it } from "vitest";

import { nextRentalStatus, rentalRowActions } from "./rentalRowActions";

// ── What the rental catalogue's row menu offers, and to whom ───────────────────────────────────
//
// The catalogue shipped with no row menu at all: retiring an item meant opening it, opening the edit
// FORM, changing a dropdown and saving — four steps for a one-click action, and the reason a
// production catalogue can sit entirely ACTIVE. These tests pin the two things that go wrong once
// that menu exists: a label that contradicts the row it is on, and an entry offered to someone who
// cannot perform it.

describe("nextRentalStatus", () => {
  it("flips active to inactive and back", () => {
    expect(nextRentalStatus("active")).toBe("inactive");
    expect(nextRentalStatus("inactive")).toBe("active");
  });
});

describe("rentalRowActions", () => {
  const all = { canEdit: true, canDelete: true };
  const keys = (opts: Parameters<typeof rentalRowActions>[0]) => rentalRowActions(opts).map((a) => a.key);
  const labels = (opts: Parameters<typeof rentalRowActions>[0]) => rentalRowActions(opts).map((a) => a.label);

  it("offers Edit · Deactivate · Delete on an ACTIVE row", () => {
    expect(labels({ status: "active", ...all })).toEqual(["Edit", "Deactivate", "Delete"]);
  });

  it("offers Edit · Activate · Delete on an INACTIVE row", () => {
    expect(labels({ status: "inactive", ...all })).toEqual(["Edit", "Activate", "Delete"]);
  });

  // The label names the RESULT of clicking, not the state being looked at. Reading the current
  // status back at the user is the version of this control everyone mis-clicks once.
  it("never labels the toggle with the state the row is already in", () => {
    const toggleFor = (status: "active" | "inactive") =>
      rentalRowActions({ status, ...all }).find((a) => a.key === "toggle-status")?.label;
    // Exact equality, not `toContain`: "Deactivate" contains "activate", so a substring assertion
    // here passes for the wrong label in one direction and fails for the right one in the other.
    expect(toggleFor("active")).toBe("Deactivate");
    expect(toggleFor("inactive")).toBe("Activate");
  });

  // ── Permission mapping ────────────────────────────────────────────────────────────────────────
  //
  // Exactly the two permissions that already exist. rentals.edit's own description in
  // backend/src/modules/role/permissions.ts reads "Edit rental items; activate / deactivate", so the
  // toggle belongs to it — no rentals.activate / rentals.deactivate / rentals.manage was invented.

  it("gates Edit AND the status toggle behind rentals.edit", () => {
    expect(keys({ status: "active", canEdit: false, canDelete: true })).toEqual(["delete"]);
  });

  it("gates Delete behind rentals.delete", () => {
    expect(keys({ status: "active", canEdit: true, canDelete: false })).toEqual(["edit", "toggle-status"]);
  });

  it("offers nothing — so the caller can drop the whole column — when the viewer has neither", () => {
    expect(rentalRowActions({ status: "active", canEdit: false, canDelete: false })).toEqual([]);
    expect(rentalRowActions({ status: "inactive", canEdit: false, canDelete: false })).toEqual([]);
  });

  it("marks only Delete as destructive", () => {
    const danger = rentalRowActions({ status: "active", ...all }).filter((a) => a.danger).map((a) => a.key);
    expect(danger).toEqual(["delete"]);
  });

  // Both catalogues sit under Inventory one tab apart. A menu that reorders itself between them,
  // or puts the destructive entry somewhere else, reads as two different products.
  it("keeps Delete last, matching the IRM catalogue's menu order", () => {
    expect(keys({ status: "active", ...all }).at(-1)).toBe("delete");
    expect(keys({ status: "inactive", ...all }).at(-1)).toBe("delete");
  });
});
