import { describe, expect, it } from "vitest";

import { railScrollDelta } from "./TabPills";

// ── The tab rail must never hold a tab nobody can reach ────────────────────────────────────────
//
// Users & Roles is four pills (~450px) and Rentals is five; a 390px phone leaves ~358px inside the
// top bar. The rail was a non-wrapping flex row with no scrolling, so the last tab was simply cut
// off at the right edge — "Job titles" was on screen, half-drawn, and unopenable.
//
// The rail now scrolls, which the suite cannot see (no renderer, no layout). What it CAN pin is the
// arithmetic that decides whether the selected pill is inside the rail and how far to move it — the
// part that would silently strand a tab off-screen if it got a sign or a comparison wrong.
//
// Coordinates are viewport rects (getBoundingClientRect), so a rail scrolled rightward reports its
// pills at SMALLER left values, not larger ones. Getting that backwards is the mistake these cases
// exist to catch: it would scroll away from the tab the user just picked.

const rail = { left: 100, right: 400 }; // 300px of visible rail

describe("railScrollDelta", () => {
  it("leaves a fully visible pill alone", () => {
    expect(railScrollDelta(rail, { left: 150, right: 250 })).toBe(0);
  });

  it("leaves a pill flush with either edge alone", () => {
    expect(railScrollDelta(rail, { left: 100, right: 200 })).toBe(0);
    expect(railScrollDelta(rail, { left: 300, right: 400 })).toBe(0);
  });

  it("scrolls RIGHT (positive) for a pill past the right edge", () => {
    // 60px of the pill is beyond the rail, plus the 4px breathing room.
    expect(railScrollDelta(rail, { left: 360, right: 460 })).toBe(64);
  });

  it("scrolls LEFT (negative) for a pill before the left edge", () => {
    expect(railScrollDelta(rail, { left: 40, right: 140 })).toBe(-64);
  });

  it("reveals the START of a pill too wide for the rail", () => {
    // Both tests match; aligning the left edge keeps the beginning of the label, which is the half
    // that says which tab it is.
    expect(railScrollDelta(rail, { left: 50, right: 500 })).toBe(-54);
  });

  it("honours a caller-supplied pad", () => {
    expect(railScrollDelta(rail, { left: 360, right: 460 }, 0)).toBe(60);
  });
});
