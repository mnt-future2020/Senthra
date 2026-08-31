import { describe, expect, it } from "vitest";

import { queryBool } from "../request.js";

/**
 * The boolean query parser, and the one mistake it exists to make impossible.
 *
 * The shorthand it replaced was `queryStr(q.flag) ? true : undefined`, which reads `?flag=false` as
 * TRUE — a non-empty string is truthy. That is not a cosmetic bug: a caller switching a narrowing
 * filter OFF switched it ON, and the symptom was rows quietly disappearing from a list rather than
 * an error anyone could see.
 *
 * The accepted spellings are the UNION of the three conventions already in this codebase (`=== "1"`,
 * `=== "true"`, and `=== "1" || === "true"`), which is the only choice that breaks no existing
 * caller: every value that used to mean true still does, and values that used to be silently ignored
 * now mean false instead of accidentally meaning true.
 */
describe("queryBool", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["True", true],
    [" true ", true],
  ] as const)("reads %j as true", (input, expected) => {
    expect(queryBool(input)).toBe(expected);
  });

  it.each([
    ["0", false],
    ["false", false],
    ["FALSE", false],
    [" false ", false],
  ] as const)("reads %j as false", (input, expected) => {
    expect(queryBool(input)).toBe(expected);
  });

  it("is undefined when the parameter is absent", () => {
    expect(queryBool(undefined)).toBeUndefined();
  });

  it.each(["", "  ", "yes", "no", "on", "off", "2", "-1", "null", "undefined"])(
    "treats the unrecognised value %j as NOT ASKED rather than guessing",
    (input) => {
      expect(queryBool(input)).toBeUndefined();
    },
  );

  it("ignores non-string values rather than coercing them", () => {
    // Express only ever hands us strings/arrays, but a coercion here would resurrect the exact
    // truthiness bug this function replaced.
    for (const v of [null, 0, 1, {}, true, false]) expect(queryBool(v)).toBeUndefined();
  });

  it("collapses a DUPLICATED parameter to its first value, like queryStr", () => {
    // `?flag=true&flag=false` arrives as an array; reading the array itself would be truthy.
    expect(queryBool(["true", "false"])).toBe(true);
    expect(queryBool(["false", "true"])).toBe(false);
  });

  // ── The regression, stated as its own case ───────────────────────────────────────────────────
  it("NEVER reads a falsey spelling as true", () => {
    for (const off of ["false", "0", "FALSE", " false "]) {
      expect(queryBool(off), `"${off}" must not be true`).not.toBe(true);
    }
  });

  it("fails the shorthand it replaced", () => {
    // Documenting the defect directly: the old expression and the new one disagree on exactly the
    // values that were broken, and agree everywhere else.
    const old = (v: unknown) => (typeof v === "string" && v ? true : undefined);
    expect(old("false")).toBe(true);
    expect(queryBool("false")).toBe(false);
    expect(old("0")).toBe(true);
    expect(queryBool("0")).toBe(false);
    // Unchanged where it was already right.
    expect(old("1")).toBe(queryBool("1"));
    expect(old("true")).toBe(queryBool("true"));
    expect(old(undefined)).toBe(queryBool(undefined));
  });
});
