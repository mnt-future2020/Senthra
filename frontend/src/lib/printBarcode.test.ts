import { describe, expect, it } from "vitest";

import { MAX_LABEL_COPIES, parseCopiesParam } from "./printBarcode";

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
