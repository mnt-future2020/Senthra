import { describe, expect, it } from "vitest";

import { tidyAddress } from "./hireActions";

// The server composes a hire's location from a line address, an order override or a warehouse, and the
// parts it joins can legitimately carry the same text twice. A real order printed:
//
//   "Unit 4, Industrial Estate, Unit 4, Industrial Estate, London, Greater London, NW10 7LT, United Kingdom"
//
// which reads as a data fault to anyone looking at it and costs a line of screen to say nothing.

describe("tidyAddress", () => {
  it("removes a repeated PAIR of segments, which is the duplication that actually occurs", () => {
    expect(
      tidyAddress("Unit 4, Industrial Estate, Unit 4, Industrial Estate, London, Greater London, NW10 7LT, United Kingdom"),
    ).toBe("Unit 4, Industrial Estate, London, Greater London, NW10 7LT, United Kingdom");
  });

  it("keeps first appearance, so the address still reads outwards", () => {
    expect(tidyAddress("Depot, London, Depot")).toBe("Depot, London");
  });

  it("matches case-insensitively and ignores the spacing around the commas", () => {
    expect(tidyAddress("Unit 4,  unit 4 , London")).toBe("Unit 4, London");
  });

  it("leaves an address with nothing repeated exactly as it was", () => {
    const a = "12 High Street, Leeds, West Yorkshire, LS1 4DY, United Kingdom";
    expect(tidyAddress(a)).toBe(a);
  });

  it("does not collapse places that merely look similar", () => {
    // "London" and "Greater London" are different segments and both are meant.
    expect(tidyAddress("London, Greater London")).toBe("London, Greater London");
  });

  it("drops empty segments left by a trailing or doubled comma", () => {
    expect(tidyAddress("Unit 4,, London,")).toBe("Unit 4, London");
  });

  it("returns null for nothing at all, rather than an empty string", () => {
    // Callers fall through to a place name on null; an empty string would print as a blank location.
    expect(tidyAddress(null)).toBeNull();
    expect(tidyAddress(undefined)).toBeNull();
    expect(tidyAddress("")).toBeNull();
    expect(tidyAddress("  ,  , ")).toBeNull();
  });
});
