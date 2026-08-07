import { describe, expect, it } from "vitest";

import { isHttpUrl, safeHttpUrls } from "../http-url.js";

describe("isHttpUrl", () => {
  it("accepts the schemes a link can safely use", () => {
    expect(isHttpUrl("https://res.cloudinary.com/x/pack.pdf")).toBe(true);
    expect(isHttpUrl("http://intranet/job-pack.pdf")).toBe(true);
    expect(isHttpUrl("  https://example.com/a.pdf  ")).toBe(true);
  });

  // The whole reason this exists. Both parse cleanly as URLs — a "is it a valid URL" check passes
  // them — and both execute when the customer clicks the link.
  it("rejects the schemes that execute", () => {
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("JavaScript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isHttpUrl("vbscript:msgbox(1)")).toBe(false);
  });

  // Not a scheme problem, but an attachment that doesn't say where it lives is not a link.
  it("rejects anything that isn't a URL at all", () => {
    expect(isHttpUrl("job-pack.pdf")).toBe(false);
    expect(isHttpUrl("/uploads/pack.pdf")).toBe(false);
    expect(isHttpUrl("")).toBe(false);
    expect(isHttpUrl("   ")).toBe(false);
  });

  // file:// would point at the VIEWER's own disk, which is never what was meant.
  it("rejects other well-formed but unusable schemes", () => {
    expect(isHttpUrl("file:///c:/secret.pdf")).toBe(false);
    expect(isHttpUrl("ftp://example.com/a.pdf")).toBe(false);
  });
});

describe("safeHttpUrls", () => {
  // The read-path guard: validation only covers writes, so rows stored before the rule existed
  // still hold whatever was typed. A customer opening a job is not the moment to surface that.
  it("keeps the safe links and drops the rest", () => {
    expect(safeHttpUrls(["https://a.com/1.pdf", "javascript:alert(1)", "notes.docx", "http://b.com/2.pdf"])).toEqual([
      "https://a.com/1.pdf",
      "http://b.com/2.pdf",
    ]);
  });

  it("handles an absent list", () => {
    expect(safeHttpUrls(null)).toEqual([]);
    expect(safeHttpUrls(undefined)).toEqual([]);
    expect(safeHttpUrls([])).toEqual([]);
  });
});
