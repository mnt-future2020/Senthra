import { describe, expect, it } from "vitest";

import { UK_POSTCODE_RE, formatUkPostcode, postcodeField } from "./postcode.js";

describe("formatUkPostcode", () => {
  it("uppercases a lowercase postcode typed without a space", () => {
    expect(formatUkPostcode("ls14dy")).toBe("LS1 4DY");
  });

  it("inserts the canonical space before the 3-character inward code", () => {
    expect(formatUkPostcode("EC1A1BB")).toBe("EC1A 1BB");
  });

  it("collapses stray internal whitespace to a single space", () => {
    expect(formatUkPostcode("LS1   4DY")).toBe("LS1 4DY");
  });

  it("trims surrounding whitespace", () => {
    expect(formatUkPostcode("  m1 1ae  ")).toBe("M1 1AE");
  });

  it.each([
    ["m11ae", "M1 1AE"],
    ["b338th", "B33 8TH"],
    ["cr26xh", "CR2 6XH"],
    ["dn551pt", "DN55 1PT"],
    ["w1a0ax", "W1A 0AX"],
    ["gir0aa", "GIR 0AA"],
  ])("normalises every UK outward-code shape: %s", (input, expected) => {
    expect(formatUkPostcode(input)).toBe(expected);
  });

  it("leaves an already-canonical postcode untouched", () => {
    expect(formatUkPostcode("LS1 4DY")).toBe("LS1 4DY");
  });

  it("returns an empty string unchanged", () => {
    expect(formatUkPostcode("")).toBe("");
  });

  it("returns unrecognisable input trimmed and uppercased rather than mangling it", () => {
    // Not a UK postcode shape — the schema's regex rejects it; the formatter must not
    // invent a space in the wrong place while the user is still typing.
    expect(formatUkPostcode("not a postcode")).toBe("NOT A POSTCODE");
  });

  it("does not split a too-short fragment", () => {
    expect(formatUkPostcode("ls1")).toBe("LS1");
  });
});

describe("UK_POSTCODE_RE", () => {
  it.each(["LS1 4DY", "ls14dy", "EC1A 1BB", "M1 1AE", "GIR 0AA", "DN55 1PT"])(
    "accepts %s",
    (v) => expect(UK_POSTCODE_RE.test(v)).toBe(true),
  );

  it.each(["", "LS1", "12345", "LSX 4DY", "LS1 4D", "LS1 4DYZ"])("rejects %s", (v) =>
    expect(UK_POSTCODE_RE.test(v)).toBe(false),
  );

  // The regex is exported and applied to RAW, un-uppercased input in places (the site-import
  // preview, the frontend form validators). The general branch is already case-insensitive via
  // [A-Za-z]; without the `i` flag the literal GIR branch would not be, so "gir0aa" would be
  // rejected in those callers while "ls14dy" was accepted.
  it.each(["gir0aa", "Gir 0aa", "GIR 0AA"])("accepts %s whatever the case", (v) =>
    expect(UK_POSTCODE_RE.test(v)).toBe(true),
  );
});

describe("postcodeField", () => {
  it("normalises the value it parses, so callers store the canonical form", () => {
    expect(postcodeField().parse("ls14dy")).toBe("LS1 4DY");
  });

  it("rejects a value that is not a UK postcode", () => {
    expect(postcodeField().safeParse("nope").success).toBe(false);
  });

  it("allows an empty string when optional (a cleared field)", () => {
    expect(postcodeField().parse("")).toBe("");
  });

  it("rejects an empty string when required", () => {
    expect(postcodeField({ required: true }).safeParse("").success).toBe(false);
  });

  // A required postcode has to NAME itself when the key is missing entirely, not fall back to
  // zod's "expected string, received undefined" — that message reaches the client verbatim
  // (validate.middleware surfaces issues[0]), and the create forms send `undefined` for a blank.
  it("names the field when a required postcode is missing altogether", () => {
    const r = postcodeField({ required: true }).safeParse(undefined);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe("Postcode is required.");
  });

  it("uses a caller-supplied required message", () => {
    const r = postcodeField({ required: true, requiredMessage: "Site postcode is required." }).safeParse(undefined);
    expect(r.error?.issues[0]?.message).toBe("Site postcode is required.");
  });

  it("normalises a value typed with stray leading/internal spaces", () => {
    expect(postcodeField().parse("  ec1a  1bb  ")).toBe("EC1A 1BB");
  });
});
