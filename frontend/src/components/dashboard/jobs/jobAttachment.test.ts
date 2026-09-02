import { describe, expect, it } from "vitest";

import { canAddJobAttachment, JOB_ATTACHMENT_MAX, parseJobAttachment, withMediaType } from "./jobAttachment";

const UPLOAD = "https://res.cloudinary.com/demo/raw/upload/v1/senthra/jobs/site-survey-a3f91b2c.pdf";

describe("parseJobAttachment", () => {
  it("returns null for a blank row, which the form keeps around while editing", () => {
    expect(parseJobAttachment("")).toBeNull();
    expect(parseJobAttachment("   ")).toBeNull();
  });

  it("strips the upload hash suffix for display but keeps the URL intact", () => {
    const a = parseJobAttachment(UPLOAD)!;
    expect(a.name).toBe("site-survey.pdf");
    expect(a.rawUrl).toBe(UPLOAD);
  });

  // The bug this guard exists for: an 8-digit date is not a hash, and trimming it renamed the user's
  // own file on the screen they use to tell two survey reports apart.
  it("leaves an 8-DIGIT suffix alone — a date is not an upload hash", () => {
    const a = parseJobAttachment("https://example.com/docs/site-report-20240115.pdf")!;
    expect(a.name).toBe("site-report-20240115.pdf");
  });

  it("still strips a hash that mixes letters and digits", () => {
    expect(parseJobAttachment("https://example.com/a/plan-1a2b3c4d.png")!.name).toBe("plan.png");
  });

  // isUploaded drives whether a row is editable. Extension-based detection made any pasted .pdf
  // read-only, so a mistyped external link could only be deleted, never corrected.
  it("treats only Cloudinary-hosted files as uploads", () => {
    expect(parseJobAttachment(UPLOAD)!.isUploaded).toBe(true);
    expect(parseJobAttachment("https://sharepoint.example.com/spec.pdf")!.isUploaded).toBe(false);
    expect(parseJobAttachment("https://drive.example.com/photo.png")!.isUploaded).toBe(false);
  });

  it("reads the #internal marker and keeps it out of the openable URL", () => {
    const a = parseJobAttachment(`${UPLOAD}#internal`)!;
    expect(a.isInternal).toBe(true);
    expect(a.rawUrl).toBe(UPLOAD);
    expect(a.url).toBe(`${UPLOAD}#internal`); // what the form writes back
    expect(a.name).toBe("site-survey.pdf"); // the marker must not leak into the name
  });

  it("does not treat a fragment that merely starts with 'internal' as the marker", () => {
    expect(parseJobAttachment("https://example.com/a.pdf#internaldocumentation")!.isInternal).toBe(false);
  });

  it("classifies the icon by kind, including Cloudinary's delivery paths", () => {
    expect(parseJobAttachment("https://example.com/a.PNG")!.isImg).toBe(true);
    expect(parseJobAttachment("https://res.cloudinary.com/d/image/upload/v1/x")!.isImg).toBe(true);
    expect(parseJobAttachment("https://example.com/a.docx")!.isDoc).toBe(true);
    const link = parseJobAttachment("https://example.com/some/page")!;
    expect([link.isImg, link.isPdf, link.isDoc]).toEqual([false, false, false]);
  });

  // Half-typed links live in this field while someone is editing; blanking them would read as data loss.
  it("shows an unparseable value verbatim rather than dropping it", () => {
    const a = parseJobAttachment("not a url")!;
    expect(a.name).toBe("not a url");
    expect(a.isUploaded).toBe(false);
  });
});

// The picker validates an EXTENSION; the server validates the MEDIA TYPE inside the data URI. A
// browser that reports no MIME for a file (a .docx on a machine with no Office install) makes those
// two disagree, and the upload is refused after it has already been sent. So the extension we
// accepted is the media type we state.
describe("withMediaType", () => {
  it("replaces a media type the browser guessed wrong", () => {
    const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    expect(withMediaType("data:application/octet-stream;base64,QUJD", DOCX)).toBe(
      "data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,QUJD",
    );
  });

  it("fills in a media type the browser left empty", () => {
    expect(withMediaType("data:;base64,QUJD", "application/pdf")).toBe("data:application/pdf;base64,QUJD");
  });

  it("keeps the payload byte-for-byte", () => {
    const payload = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";
    expect(withMediaType(`data:image/png;base64,${payload}`, "image/jpeg")).toBe(`data:image/jpeg;base64,${payload}`);
  });

  it("is idempotent when the type already matches", () => {
    const uri = "data:application/pdf;base64,QUJD";
    expect(withMediaType(uri, "application/pdf")).toBe(uri);
  });

  // Rewriting a string we do not recognise would corrupt it, and a caller passing one has a
  // different problem than its media type.
  it.each(["", "not a data uri", "https://res.cloudinary.com/x/raw/upload/a.pdf", "data:text/plain,hello"])(
    "leaves %o untouched",
    (input) => {
      expect(withMediaType(input, "application/pdf")).toBe(input);
    },
  );
});

// Spreadsheets are DOCUMENTS on screen, not pasted links.
//
// Jobs began accepting CSV/XLS/XLSX without this file learning about them, so `isDoc` stayed
// docx/doc-only and every spreadsheet fell through to the LinkIcon branch — the affordance that
// means "somebody typed a URL here" — on the job form, the job detail, the engineer's job page and
// the customer portal. Four screens, one shared parser, one missing list.
describe("spreadsheet attachments render as documents", () => {
  const url = (name: string) => `https://res.cloudinary.com/demo/raw/upload/v1/senthra/jobs/${name}`;

  it.each(["prices.csv", "prices.xls", "prices.xlsx"])("%s is a document, not a link", (name) => {
    const a = parseJobAttachment(url(name))!;
    expect(a.isDoc, `${name} should be a document`).toBe(true);
    expect(a.isImg).toBe(false);
    expect(a.isPdf).toBe(false);
  });

  // The renderers branch on `isPdf || isDoc`, so this is the property that actually decides the icon.
  it.each(["quote.pdf", "spec.docx", "spec.doc", "boq.csv", "boq.xls", "boq.xlsx"])(
    "%s takes the file icon rather than the link icon",
    (name) => {
      const a = parseJobAttachment(url(name))!;
      expect(a.isPdf || a.isDoc).toBe(true);
    },
  );

  // A genuinely pasted link must still read as one — that branch is what keeps it editable.
  it.each(["https://example.com/somewhere", "https://sharepoint.example.com/a/b"])(
    "%o stays a link",
    (raw) => {
      const a = parseJobAttachment(raw)!;
      expect(a.isPdf || a.isDoc || a.isImg).toBe(false);
    },
  );

  it("still treats images as images rather than documents", () => {
    const a = parseJobAttachment(url("site.png"))!;
    expect(a.isImg).toBe(true);
    expect(a.isDoc).toBe(false);
  });
});

// ── The real delivery-URL shape ────────────────────────────────────────────────────────────────
//
// Cloudinary appends an analytics parameter to signed delivery URLs, so a stored attachment looks
// like `…/schedule-<uuid>.xlsx?_a=BAMAPqfm0`. Every extension test that read the WHOLE string
// therefore failed on it. `isImg`/`isPdf` masked that with their `/image/upload/` and `/raw/upload/`
// fallbacks; `isDoc` had none, so DOCX rendered as an external link long before spreadsheets did.
//
// These use the exact shape observed in the browser. Without the path fix they all fail.
describe("extension is read from the path, not the query string", () => {
  const signed = (name: string) =>
    `https://res.cloudinary.com/demo/raw/upload/s--BIe-y1sY--/v1/senthra/jobs/${name}?_a=BAMAPqfm0`;

  it.each(["schedule.xlsx", "prices.xls", "boq.csv", "spec.docx"])(
    "%s with an analytics query is still a document",
    (name) => {
      expect(parseJobAttachment(signed(name))!.isDoc).toBe(true);
    },
  );

  it("a PDF with an analytics query is still a PDF", () => {
    expect(parseJobAttachment(signed("quote.pdf"))!.isPdf).toBe(true);
  });

  it("an image with an analytics query is still an image", () => {
    const url = "https://res.cloudinary.com/demo/image/upload/v1/senthra/jobs/site.png?_a=BAMAPqfm0";
    const a = parseJobAttachment(url)!;
    expect(a.isImg).toBe(true);
    expect(a.isDoc).toBe(false);
  });

  // None of them may be mistaken for a pasted link — that branch makes the row an editable text box.
  it.each(["schedule.xlsx", "boq.csv", "spec.docx", "quote.pdf"])("%s never falls through to the link branch", (name) => {
    const a = parseJobAttachment(signed(name))!;
    expect(a.isImg || a.isPdf || a.isDoc).toBe(true);
  });

  // A fragment must be stripped for the same reason, and `#internal` must still be understood.
  it("handles the #internal marker alongside a query string", () => {
    const a = parseJobAttachment(`${signed("boq.csv")}#internal`)!;
    expect(a.isInternal).toBe(true);
    expect(a.isDoc).toBe(true);
  });

  // A half-typed value is not a URL; matching must not throw on it.
  it.each(["", "not a url", "https://", "example.com/a.csv?x=1"])("survives the unparseable value %o", (raw) => {
    expect(() => parseJobAttachment(raw)).not.toThrow();
  });
});

// One cap, both interaction paths. The buttons disabled at 20 while a DROP checked nothing, so
// dragging past the ceiling appended a 21st that persisted — the server's own limit being 50.
describe("canAddJobAttachment", () => {
  it("allows the last slot", () => {
    expect(canAddJobAttachment(JOB_ATTACHMENT_MAX - 1)).toBe(true);
  });

  it("refuses once the cap is reached", () => {
    expect(canAddJobAttachment(JOB_ATTACHMENT_MAX)).toBe(false);
  });

  // Defensive: a count already over the cap (a record written before the rule) must not reopen it.
  it("refuses beyond the cap", () => {
    expect(canAddJobAttachment(JOB_ATTACHMENT_MAX + 5)).toBe(false);
  });

  it("allows an empty list", () => {
    expect(canAddJobAttachment(0)).toBe(true);
  });

  it("caps at the client-visible 20, not the server's larger ceiling", () => {
    expect(JOB_ATTACHMENT_MAX).toBe(20);
  });
});

// The publicId gained a full UUID (32 bits of truncated hash was a collision waiting to happen), and
// the display name has to keep hiding it — otherwise every attachment reads as
// `site-survey-a3f91b2c-4d5e-...pdf`. Both shapes are live: the database still holds the short form.
describe("upload suffix is hidden in both id shapes", () => {
  const at = (name: string) => `https://res.cloudinary.com/demo/raw/upload/v1/senthra/jobs/${name}`;

  it("hides a full UUID suffix", () => {
    expect(parseJobAttachment(at("site-survey-a3f91b2c-4d5e-6f70-8901-234567890abc.pdf"))!.name).toBe("site-survey.pdf");
  });

  it("still hides the earlier 8-hex suffix", () => {
    expect(parseJobAttachment(at("site-survey-a3f91b2c.pdf"))!.name).toBe("site-survey.pdf");
  });

  it("hides a UUID whose groups happen to be all digits", () => {
    // No letter guard is needed for the UUID shape — the 8-4-4-4-12 layout is unmistakable.
    expect(parseJobAttachment(at("plan-12345678-1234-1234-1234-123456789012.pdf"))!.name).toBe("plan.pdf");
  });

  // The reason the short form keeps its letter guard.
  it("leaves an 8-digit date in the user's own file name alone", () => {
    expect(parseJobAttachment(at("site-report-20240115.pdf"))!.name).toBe("site-report-20240115.pdf");
  });

  it("leaves a name with no suffix alone", () => {
    expect(parseJobAttachment(at("delivery-note.pdf"))!.name).toBe("delivery-note.pdf");
  });

  it("keeps a hyphenated name intact either side of the suffix", () => {
    expect(parseJobAttachment(at("rams-rev-c-final-a3f91b2c-4d5e-6f70-8901-234567890abc.docx"))!.name).toBe("rams-rev-c-final.docx");
  });
});
