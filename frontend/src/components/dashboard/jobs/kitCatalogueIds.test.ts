import { describe, expect, it } from "vitest";

import { irmKitLineIds, rentalKitLineIds } from "./kitCatalogueIds";

const line = (lineType: string, over: { irmItemId?: string; rentalItemId?: string } = {}) => ({
  lineType,
  irmItemId: "",
  rentalItemId: "",
  ...over,
});

/**
 * These feed the batched `?ids=` lookups that resolve an edit-mode selection sitting outside the
 * page loaded at mount. Sending the wrong catalogue's ids fails SILENTLY — they resolve to nothing
 * and the picker renders blank on a line that is set, which is the bug this all exists to fix.
 */
describe("kit line catalogue ids", () => {
  const lines = [
    line("rental", { rentalItemId: "r1" }),
    line("irm", { irmItemId: "i1" }),
    line("rental", { rentalItemId: "r2" }),
    line("customer_stock"),
    line("misc"),
  ];

  it("takes rental ids from rental lines only", () => {
    expect(rentalKitLineIds(lines)).toEqual(["r1", "r2"]);
  });

  it("takes IRM ids from IRM lines only", () => {
    expect(irmKitLineIds(lines)).toEqual(["i1"]);
  });

  // The two catalogues must never bleed into each other: an IRM id sent to /rental-items resolves
  // to nothing at all, and the failure is invisible.
  it("never leaks one catalogue's ids into the other", () => {
    expect(rentalKitLineIds(lines)).not.toContain("i1");
    expect(irmKitLineIds(lines)).not.toContain("r1");
  });

  it("ignores line types that reference no catalogue", () => {
    expect(rentalKitLineIds([line("customer_stock"), line("misc")])).toEqual([]);
    expect(irmKitLineIds([line("customer_stock"), line("misc")])).toEqual([]);
  });

  // Blanks are kept on purpose — `missingIds` drops them. Filtering here too would put the same
  // rule in two places and invite them to disagree.
  it("keeps blank ids for the shared filter to drop", () => {
    expect(rentalKitLineIds([line("rental")])).toEqual([""]);
  });

  // Identity is the id. Two hired items may share a name, and both must still be asked for.
  it("returns every id, including same-name different-id lines", () => {
    const dupes = [line("rental", { rentalItemId: "aaa" }), line("rental", { rentalItemId: "bbb" })];
    expect(rentalKitLineIds(dupes)).toEqual(["aaa", "bbb"]);
  });

  it("returns nothing for an empty kit", () => {
    expect(rentalKitLineIds([])).toEqual([]);
    expect(irmKitLineIds([])).toEqual([]);
  });
});
