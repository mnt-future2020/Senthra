import { describe, expect, it } from "vitest";

import { returnLegSummary } from "./rentalReturn";

const WAREHOUSE = "3/359, Ayyanar Nagar, Leeds, LS1 4DY, United Kingdom";
const SITE = "12 Site Road, Leeds";

describe("returnLegSummary — the short form of the return leg", () => {
  // The case that started this: the same string printed twice in one cell.
  it("does not repeat the line's own delivery address", () => {
    expect(returnLegSummary("delivery", { label: "Same as delivery", address: SITE }, SITE)).toBe("same as delivery");
  });

  // The page header already names the warehouse and its address in full.
  it("does not repeat the warehouse address a line without an address of its own resolves to", () => {
    expect(returnLegSummary("delivery", { label: "Same as delivery", address: WAREHOUSE }, null)).toBe(
      "same as delivery",
    );
  });

  // Delivered to a site, collected from the depot — two different places, and the NAME is what
  // identifies the depot. Its address is in the header.
  it("names the warehouse when the hire goes back to one", () => {
    expect(returnLegSummary("warehouse", { label: "test work", address: WAREHOUSE }, SITE)).toBe("test work");
  });

  it("falls back to the resolver's own label for a warehouse with no name", () => {
    expect(returnLegSummary("warehouse", { label: "Delivery warehouse", address: WAREHOUSE }, null)).toBe(
      "Delivery warehouse",
    );
  });

  // The one mode naming a place nothing else on the page mentions — so this one prints in full.
  it("shows a third address in full", () => {
    expect(returnLegSummary("other", { label: "Other address", address: "9 Collection Yard, Leeds" }, SITE)).toBe(
      "9 Collection Yard, Leeds",
    );
  });

  it("shows a third address in full even when the line has no delivery address of its own", () => {
    expect(returnLegSummary("other", { label: "Other address", address: "9 Collection Yard, Leeds" }, null)).toBe(
      "9 Collection Yard, Leeds",
    );
  });

  // Typing the delivery address into the collection box names the same place, whatever the mode says.
  it("treats an 'other' address equal to the delivery address as the same place", () => {
    expect(returnLegSummary("other", { label: "Other address", address: SITE }, SITE)).toBe("same as delivery");
  });

  it("ignores case, line breaks and repeated spaces when comparing", () => {
    expect(
      returnLegSummary("other", { label: "Other address", address: "12 site  road,\nleeds" }, "12 Site Road, Leeds"),
    ).toBe("same as delivery");
  });

  // An address the resolver could not produce must not print "null" — the label is the fallback, the
  // same one the screens used before this function existed.
  it("uses the label when there is no address to show", () => {
    expect(returnLegSummary("other", { label: "Other address", address: null }, null)).toBe("Other address");
  });

  // The server's resolver treats an unrecognised mode as `delivery`; so must this, or a screen would
  // describe a different mode from the one the order document prints.
  it("treats an unrecognised mode as delivery, exactly as the server does", () => {
    expect(returnLegSummary("banana", { label: "Same as delivery", address: WAREHOUSE }, null)).toBe(
      "same as delivery",
    );
    expect(returnLegSummary("", { label: "Same as delivery", address: SITE }, SITE)).toBe("same as delivery");
  });
});
