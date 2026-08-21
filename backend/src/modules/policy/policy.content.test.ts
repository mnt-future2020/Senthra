import { describe, expect, it } from "vitest";

import { parsePolicyBody } from "./policy.content.js";

describe("policy content — the three rules", () => {
  it("returns nothing for an empty or whitespace-only body", () => {
    expect(parsePolicyBody("")).toEqual([]);
    expect(parsePolicyBody("   \n\n  \n")).toEqual([]);
  });

  it('reads "# " as a heading', () => {
    expect(parsePolicyBody("# Who we are")).toEqual([{ type: "heading", text: "Who we are" }]);
  });

  it('reads "- " lines as ONE list', () => {
    expect(parsePolicyBody("- Cloudinary\n- Firebase\n- postcodes.io")).toEqual([
      { type: "list", items: ["Cloudinary", "Firebase", "postcodes.io"] },
    ]);
  });

  it("separates blocks on a blank line", () => {
    expect(parsePolicyBody("First para.\n\nSecond para.")).toEqual([
      { type: "paragraph", text: "First para." },
      { type: "paragraph", text: "Second para." },
    ]);
  });

  it("keeps the author's line breaks inside one paragraph", () => {
    // Addresses and stacked clauses depend on this; reflowing them into one line loses meaning.
    expect(parsePolicyBody("Line one\nLine two")).toEqual([
      { type: "paragraph", text: "Line one\nLine two" },
    ]);
  });

  it("handles a full document — headings, prose and lists interleaved", () => {
    const body = ["# Who we are", "", "We are the controller.", "", "- One", "- Two", "", "# Rights", "", "You have rights."].join("\n");
    expect(parsePolicyBody(body)).toEqual([
      { type: "heading", text: "Who we are" },
      { type: "paragraph", text: "We are the controller." },
      { type: "list", items: ["One", "Two"] },
      { type: "heading", text: "Rights" },
      { type: "paragraph", text: "You have rights." },
    ]);
  });

  it("starts a new block when the kind changes, with no blank line between", () => {
    expect(parsePolicyBody("Intro text\n- bullet\nOutro text")).toEqual([
      { type: "paragraph", text: "Intro text" },
      { type: "list", items: ["bullet"] },
      { type: "paragraph", text: "Outro text" },
    ]);
  });

  it("normalises CRLF so a Windows paste behaves like any other", () => {
    expect(parsePolicyBody("# Title\r\n\r\nBody.")).toEqual([
      { type: "heading", text: "Title" },
      { type: "paragraph", text: "Body." },
    ]);
  });
});

describe("policy content — what is NOT syntax", () => {
  it("treats a hash with no space as ordinary prose", () => {
    expect(parsePolicyBody("#hashtag not a heading")).toEqual([
      { type: "paragraph", text: "#hashtag not a heading" },
    ]);
  });

  it("treats a hyphen with no space as ordinary prose", () => {
    expect(parsePolicyBody("-5 degrees")).toEqual([{ type: "paragraph", text: "-5 degrees" }]);
  });

  it("drops a bare marker rather than emitting an empty block", () => {
    expect(parsePolicyBody("# ")).toEqual([]);
    expect(parsePolicyBody("- ")).toEqual([]);
  });

  it("has no inline syntax at all — asterisks, underscores and brackets are literal", () => {
    const body = "**not bold** _not italic_ [not a link](http://x)";
    expect(parsePolicyBody(body)).toEqual([{ type: "paragraph", text: body }]);
  });
});

/**
 * The security property this content model exists for. The parser emits TEXT, never markup, so
 * markup-looking input survives as characters — there is no stage at which it becomes HTML.
 */
describe("policy content — markup is data, never markup", () => {
  it("carries a script tag through as literal paragraph text", () => {
    const evil = '<script>alert("xss")</script>';
    expect(parsePolicyBody(evil)).toEqual([{ type: "paragraph", text: evil }]);
  });

  it("carries an img onerror payload through as literal text", () => {
    const evil = '<img src=x onerror="alert(1)">';
    expect(parsePolicyBody(evil)).toEqual([{ type: "paragraph", text: evil }]);
  });

  it("keeps markup literal inside headings and list items too", () => {
    const parsed = parsePolicyBody("# <b>Bold?</b>\n\n- <i>Italic?</i>");
    expect(parsed).toEqual([
      { type: "heading", text: "<b>Bold?</b>" },
      { type: "list", items: ["<i>Italic?</i>"] },
    ]);
  });

  it("never produces a block type other than the three declared kinds", () => {
    const parsed = parsePolicyBody("# H\n\ntext\n\n- a\n\n<div>x</div>");
    for (const b of parsed) expect(["heading", "paragraph", "list"]).toContain(b.type);
  });
});
