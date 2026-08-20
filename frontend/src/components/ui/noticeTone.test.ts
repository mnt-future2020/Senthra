import { describe, expect, it } from "vitest";

import { NOTICE_SIZE_CLS, NOTICE_TONE_CLS, type NoticeSize, type NoticeType } from "./noticeTone";

const ALL: NoticeType[] = ["success", "warn", "error"];
const SIZES: NoticeSize[] = ["xs", "sm", "md"];

// Notice was `success ? green : red` — a boolean, not a lookup. That shape is why a NON-BLOCKING
// advisory ("you already have an open request… you can still send this one") rendered in the same
// red as a hard failure: anything that wasn't success fell through to the error branch. Widening the
// union alone could not have caught that, because a boolean check still compiles.
//
// These tests make the fall-through impossible: every tier must resolve to its OWN style, so a
// future tier that isn't wired up fails here instead of silently shipping as "error".
describe("NOTICE_TONE_CLS — one visual tier per severity", () => {
  it("gives every severity a style", () => {
    for (const t of ALL) expect(NOTICE_TONE_CLS[t]).toBeTruthy();
  });

  it("never renders two severities identically", () => {
    expect(new Set(ALL.map((t) => NOTICE_TONE_CLS[t])).size).toBe(ALL.length);
  });

  // The specific regression: warn must not borrow the error colour. --neg is the app's "broken /
  // blocked" token, and a message ending "you can still send this one" is neither.
  it("keeps warn off the error colour", () => {
    expect(NOTICE_TONE_CLS.warn).not.toContain("--neg");
    expect(NOTICE_TONE_CLS.warn).not.toBe(NOTICE_TONE_CLS.error);
  });

  // Amber is already this codebase's advisory colour — ~50 components use text-amber-600 for exactly
  // this kind of message, including the "you'll need 2 stops" line that sits directly beneath a
  // Notice. Pinning it is what lets those bare <p> advisories fold into Notice with no visual change.
  it("uses the amber the rest of the app already treats as advisory", () => {
    expect(NOTICE_TONE_CLS.warn).toContain("amber");
  });

  it("still reserves the positive and negative tokens for success and error", () => {
    expect(NOTICE_TONE_CLS.success).toContain("--pos");
    expect(NOTICE_TONE_CLS.error).toContain("--neg");
  });
});

// Two densities, because a Notice does two different jobs. At the bottom of a form it is the reply to
// "I pressed Save" and deserves the room. Inline against a table row it is a footnote — and at form
// size, two stacked advisories ate more vertical space than the items they were commenting on.
describe("NOTICE_SIZE_CLS — form-level vs inline density", () => {
  it("gives every size a style, and none of them the same one", () => {
    for (const s of SIZES) expect(NOTICE_SIZE_CLS[s]).toBeTruthy();
    expect(new Set(SIZES.map((s) => NOTICE_SIZE_CLS[s])).size).toBe(SIZES.length);
  });

  // The compact tiers have to actually be compact — asserted on the type scale rather than the
  // padding, because the type is what drives the block's height.
  it("steps the type down at each tier", () => {
    expect(NOTICE_SIZE_CLS.xs).toContain("text-[11px]");
    expect(NOTICE_SIZE_CLS.sm).toContain("text-xs");
    expect(NOTICE_SIZE_CLS.md).toContain("text-sm");
  });

  // `xs` exists to sit INSIDE a read-only detail card, among 11px labels and 14px values. At sm it
  // read as the loudest thing on the card — louder than the figures it was commenting on. 11px is
  // the register every inline hint in the app already uses (hintCls in styles.ts).
  it("matches the inline-hint register the rest of the app uses", () => {
    expect(NOTICE_SIZE_CLS.xs).toContain("text-[11px]");
    expect(NOTICE_SIZE_CLS.xs).not.toContain("text-xs");
  });

  // 39 call sites render a bare <Notice msg={…} /> with no size. They were all written against the
  // form-level look, so md staying the default is the contract that keeps them unchanged.
  it("keeps md as the shape the existing call sites were written for", () => {
    expect(NOTICE_SIZE_CLS.md).toContain("px-3.5");
    expect(NOTICE_SIZE_CLS.md).toContain("py-2.5");
  });
});
