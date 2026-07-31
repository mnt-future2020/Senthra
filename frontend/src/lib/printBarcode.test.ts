import { describe, expect, it } from "vitest";

import { MAX_LABEL_COPIES, copiesError, parseCopiesParam, resolveCopies } from "./printBarcode";

// ?copies= comes from a URL, so it's whatever the address bar says. A bad value must fall back to
// the caller's own default (the entry quantity) rather than seeding the print field with junk —
// getting this wrong prints the wrong number of stickers onto physical stock.
describe("parseCopiesParam", () => {
  it("accepts a whole number inside the allowed range", () => {
    expect(parseCopiesParam("12")).toBe(12);
    expect(parseCopiesParam("1")).toBe(1);
    expect(parseCopiesParam(String(MAX_LABEL_COPIES))).toBe(MAX_LABEL_COPIES);
  });

  it("rejects a missing or blank param", () => {
    expect(parseCopiesParam(null)).toBeNull();
    expect(parseCopiesParam(undefined)).toBeNull();
    expect(parseCopiesParam("")).toBeNull();
    expect(parseCopiesParam("   ")).toBeNull();
  });

  it("rejects anything that isn't a number", () => {
    expect(parseCopiesParam("abc")).toBeNull();
    expect(parseCopiesParam("12abc")).toBeNull();
    expect(parseCopiesParam("<script>")).toBeNull();
  });

  it("rejects fractions — half a sticker is not a thing", () => {
    expect(parseCopiesParam("2.5")).toBeNull();
  });

  it("rejects zero and negatives", () => {
    expect(parseCopiesParam("0")).toBeNull();
    expect(parseCopiesParam("-5")).toBeNull();
  });

  it("rejects a count above the print cap", () => {
    // The cap exists so a mistyped count can't lock the browser building the document.
    expect(parseCopiesParam(String(MAX_LABEL_COPIES + 1))).toBeNull();
    expect(parseCopiesParam("99999")).toBeNull();
  });

  it("rejects Infinity and NaN spellings", () => {
    expect(parseCopiesParam("Infinity")).toBeNull();
    expect(parseCopiesParam("NaN")).toBeNull();
  });
});

// What a copies box PRINTS. Every barcode surface routes through this, so the number on the button
// and the number of stickers that come out of the printer can't disagree — they used to, because
// the GRN form and the stock-entry page each carried their own copy of the rules.
describe("resolveCopies", () => {
  it("uses the surface's default when the box is blank", () => {
    expect(resolveCopies("", 50)).toBe(50);
    expect(resolveCopies("   ", 7)).toBe(7);
  });

  it("uses the typed value when there is one", () => {
    expect(resolveCopies("3", 50)).toBe(3);
  });

  it("clamps a default that exceeds the print cap", () => {
    // An entry's quantity is a RUNNING TOTAL, so it can grow past the cap over its life. Without
    // the clamp the panel would open with the button already disabled and nothing typed.
    expect(resolveCopies("", MAX_LABEL_COPIES + 500)).toBe(MAX_LABEL_COPIES);
  });

  it("floors a default of zero or less to one label", () => {
    expect(resolveCopies("", 0)).toBe(1);
    expect(resolveCopies("", -3)).toBe(1);
  });

  it("returns null for a typed value that can't print, so the caller disables the button", () => {
    expect(resolveCopies("2.5", 10)).toBeNull();
    expect(resolveCopies("abc", 10)).toBeNull();
    expect(resolveCopies("0", 10)).toBeNull();
    expect(resolveCopies(String(MAX_LABEL_COPIES + 1), 10)).toBeNull();
  });
});

// The message is DERIVED from parseCopiesParam, never a second opinion on validity.
describe("copiesError", () => {
  it("says nothing for a blank box — blank means 'use the default'", () => {
    expect(copiesError("")).toBeNull();
    expect(copiesError("   ")).toBeNull();
  });

  it("says nothing for a printable count", () => {
    expect(copiesError("1")).toBeNull();
    expect(copiesError(String(MAX_LABEL_COPIES))).toBeNull();
  });

  it("names the cap when the count is too high", () => {
    expect(copiesError(String(MAX_LABEL_COPIES + 1))).toBe(`Up to ${MAX_LABEL_COPIES} labels per print run.`);
  });

  it("asks for a whole number for fractions, junk and non-positives", () => {
    const msg = "Enter a whole number of at least 1.";
    expect(copiesError("2.5")).toBe(msg);
    expect(copiesError("abc")).toBe(msg);
    expect(copiesError("0")).toBe(msg);
    expect(copiesError("-5")).toBe(msg);
  });

  // The invariant that matters: an error shown <=> nothing to print.
  it("errors on exactly the inputs resolveCopies refuses", () => {
    for (const raw of ["", "1", "12", "2.5", "abc", "0", "-5", "Infinity", String(MAX_LABEL_COPIES), String(MAX_LABEL_COPIES + 1)]) {
      expect(copiesError(raw) === null).toBe(resolveCopies(raw, 1) !== null);
    }
  });
});
