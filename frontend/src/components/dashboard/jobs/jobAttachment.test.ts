import { describe, expect, it } from "vitest";

import { ATTACHMENT_MEDIA_TYPE, parseJobAttachment, withMediaType } from "./jobAttachment";

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
    expect(withMediaType("data:application/octet-stream;base64,QUJD", ATTACHMENT_MEDIA_TYPE.docx!)).toBe(
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

// The picker's `accept` list, the client check and the server's allow-list are three statements of
// one rule. This pins the middle one to the shape the server names.
describe("ATTACHMENT_MEDIA_TYPE", () => {
  it("covers exactly the extensions the picker offers", () => {
    expect(Object.keys(ATTACHMENT_MEDIA_TYPE).sort()).toEqual(["docx", "jpeg", "jpg", "pdf", "png"]);
  });

  it("maps both JPEG spellings to one media type", () => {
    expect(ATTACHMENT_MEDIA_TYPE.jpg).toBe(ATTACHMENT_MEDIA_TYPE.jpeg);
  });

  it("names the media types the server's allow-list accepts", () => {
    expect(Object.values(ATTACHMENT_MEDIA_TYPE)).toEqual(
      expect.arrayContaining([
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "image/png",
        "image/jpeg",
      ]),
    );
  });
});
