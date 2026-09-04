import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  listScrollTop,
  suggestInputKey,
  suggestMatches,
  type SuggestInputKeyState,
} from "./suggestInputKeys";

// The keyboard and scroll contract of <SuggestInput>, asserted without a DOM — this suite is
// Node-only, so a decision left inside a React handler is a decision nothing can test. Every case
// below is a bug that shipped in the first version of this component.

const state = (over: Partial<SuggestInputKeyState> = {}): SuggestInputKeyState => ({
  listVisible: true,
  active: 0,
  count: 6,
  ...over,
});

describe("Escape belongs to the innermost layer that can act on it", () => {
  it("closes the list and stops the event while a list is on screen", () => {
    const r = suggestInputKey("Escape", state({ listVisible: true }));
    expect(r.action).toEqual({ type: "close" });
    expect(r.stopPropagation, "the parent dialog must not also see this Escape").toBe(true);
  });

  // THE regression this file exists for. The field opens on FOCUS, so its internal `open` flag is
  // true while someone types a value no suggestion matches — and no list renders. Deciding from that
  // flag swallowed a press with nothing to dismiss, leaving the dialog un-closable by keyboard.
  it("lets Escape through when the query matches nothing, so no list is showing", () => {
    const r = suggestInputKey("Escape", state({ listVisible: false, count: 0 }));
    expect(r.action).toEqual({ type: "none" });
    expect(r.stopPropagation, "the dialog must still close on Escape").toBe(false);
  });

  it("lets Escape through once the list has already been dismissed", () => {
    expect(suggestInputKey("Escape", state({ listVisible: false })).stopPropagation).toBe(false);
  });
});

describe("arrow keys", () => {
  it("opens a closed list at the first row on ArrowDown", () => {
    expect(suggestInputKey("ArrowDown", state({ listVisible: false, active: -1 })).action).toEqual({
      type: "open",
      index: 0,
    });
  });

  it("opens a closed list at the last row on ArrowUp", () => {
    expect(suggestInputKey("ArrowUp", state({ listVisible: false, active: -1, count: 6 })).action).toEqual({
      type: "open",
      index: 5,
    });
  });

  it("moves down and wraps past the end", () => {
    expect(suggestInputKey("ArrowDown", state({ active: 5, count: 6 })).action).toEqual({ type: "move", index: 0 });
  });

  it("moves up and wraps past the start", () => {
    expect(suggestInputKey("ArrowUp", state({ active: 0, count: 6 })).action).toEqual({ type: "move", index: 5 });
  });

  it("starts at the first row when nothing is highlighted yet", () => {
    expect(suggestInputKey("ArrowDown", state({ active: -1 })).action).toEqual({ type: "move", index: 0 });
  });

  it("does nothing when the query left no suggestions", () => {
    expect(suggestInputKey("ArrowDown", state({ count: 0, listVisible: false })).action).toEqual({ type: "none" });
  });
});

describe("Enter", () => {
  it("commits the highlighted suggestion", () => {
    const r = suggestInputKey("Enter", state({ active: 2 }));
    expect(r.action).toEqual({ type: "commit", index: 2 });
    expect(r.preventDefault).toBe(true);
  });

  // The field is FREE TEXT: someone typing a value absent from the list must be able to submit the
  // form with Enter, so the key only counts when a row is actually highlighted.
  it("falls through when nothing is highlighted, so the form still submits", () => {
    const r = suggestInputKey("Enter", state({ active: -1 }));
    expect(r.action).toEqual({ type: "none" });
    expect(r.preventDefault).toBe(false);
  });

  it("falls through when no list is showing", () => {
    expect(suggestInputKey("Enter", state({ listVisible: false, active: 1 })).action).toEqual({ type: "none" });
  });
});

describe("which suggestions a query leaves", () => {
  const COUNTRIES = ["United Kingdom", "Ireland", "France", "Germany", "Netherlands", "Spain"];

  it("offers everything for an empty query", () => {
    expect(suggestMatches(COUNTRIES, "")).toEqual(COUNTRIES);
    expect(suggestMatches(COUNTRIES, "   ")).toEqual(COUNTRIES);
  });

  it("filters case-insensitively on a substring", () => {
    expect(suggestMatches(COUNTRIES, "ger")).toEqual(["Germany"]);
    expect(suggestMatches(COUNTRIES, "LAND")).toEqual(["Ireland", "Netherlands"]);
  });

  // Country DEFAULTS to "United Kingdom", so a plain substring filter left the box showing the one
  // row already in it — and picking Ireland meant deleting the text first.
  it("offers the whole list again once the value IS one of the suggestions", () => {
    expect(suggestMatches(COUNTRIES, "United Kingdom")).toEqual(COUNTRIES);
    expect(suggestMatches(COUNTRIES, "  united kingdom  ")).toEqual(COUNTRIES);
  });

  it("leaves nothing for a value of the user's own", () => {
    expect(suggestMatches(COUNTRIES, "Portugal")).toEqual([]);
  });
});

describe("keeping the highlighted row on screen", () => {
  // 10 industry options in a 224px popup shows about five, so ArrowDown used to highlight a row
  // nobody could see — and Enter then committed a value the user had never read.
  const ROW = 36;
  const VIEW = 224;

  it("leaves the scroll alone while the row is already visible", () => {
    expect(listScrollTop(0, 0, ROW, VIEW)).toBe(0);
    expect(listScrollTop(0, 5 * ROW, ROW, VIEW)).toBe(0);
  });

  it("scrolls down just far enough to reveal a row below the fold", () => {
    expect(listScrollTop(0, 9 * ROW, ROW, VIEW)).toBe(10 * ROW - VIEW);
  });

  it("scrolls up to a row above the fold", () => {
    expect(listScrollTop(200, ROW, ROW, VIEW)).toBe(ROW);
  });

  it("wrapping from the last row back to the first returns to the top", () => {
    expect(listScrollTop(10 * ROW - VIEW, 0, ROW, VIEW)).toBe(0);
  });
});

// ── Source rules ────────────────────────────────────────────────────────────────────────────────
// Two facts that live in JSX rather than in a function, and both were bugs. Asserted from source
// because this suite has no DOM — the alternative is asserting nothing at all.
const SRC = readFileSync(join(process.cwd(), "src", "components", "ui", "SuggestInput.tsx"), "utf8");
// A CRLF-safe stripper. JavaScript counts \r as a line terminator, so `.` stops before it and a
// `//.*$` matcher then fails to match at all — on a CRLF checkout it silently strips nothing, and
// the rules below would read their own explanatory comments as though they were code.
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
const CODE = stripComments(SRC);

describe("SuggestInput's suggestion rows stay out of the tab sequence", () => {
  // A row is a <button> so it stays clickable and touch-friendly, but Modal's focus trap re-queries
  // `button:not([disabled])` on every Tab — so tabbable rows spliced the whole list into the
  // dialog's tab order, and the popup then hung over the controls below it.
  it("marks the option button tabIndex={-1}", () => {
    const option = CODE.slice(CODE.indexOf('role="option"'));
    expect(option.slice(0, 400)).toContain("tabIndex={-1}");
  });

  it("still renders the rows as real buttons", () => {
    expect(CODE).toContain('role="option"');
    expect(CODE).toMatch(/<button/);
  });

  it("closes the list when focus leaves the component", () => {
    expect(CODE, "a popup left open over the next field steals its clicks").toMatch(/onBlur=\{/);
    expect(CODE).toContain("relatedTarget");
  });
});
