import { describe, expect, it } from "vitest";

import {
  allowedFrom,
  BASE_DOC_ACCEPT,
  BASE_DOC_LABEL,
  BUSINESS_DOC_ACCEPT,
  BUSINESS_DOC_LABEL,
  EXT_FILE_TYPE,
  EXT_MEDIA_TYPE,
  resolveFileType,
} from "./uploadPolicy";

// This module is the browser half of backend/src/modules/upload/upload.catalog.ts. Nothing here is a
// security boundary — the server re-checks every one of these decisions and reads the stored bytes —
// but a disagreement between the two is a file the dialog offers and the upload then refuses, which
// the user reads as a bug in the app rather than a rule about their file.
//
// The rule these exist to protect is the SPLIT: PRF/PO/Job take spreadsheets, GRN does not. It is one
// line to "fix" that apparent inconsistency by pointing both at the same list.

const BUSINESS = allowedFrom(BUSINESS_DOC_ACCEPT);
const BASE = allowedFrom(BASE_DOC_ACCEPT);

describe("business-document policy (PRF, PO, Job)", () => {
  it.each(["quote.pdf", "spec.docx", "photo.png", "photo.jpg", "photo.jpeg"])("accepts %s", (name) => {
    expect(resolveFileType(name, BUSINESS)).not.toBeNull();
  });

  // The client's request. A supplier's price breakdown arrives as a workbook far more often than as
  // a PDF, and printing it to PDF to attach it loses the figures the buyer wanted to check.
  it.each([
    ["prices.csv", "csv"],
    ["prices.xls", "xls"],
    ["prices.xlsx", "xlsx"],
  ])("accepts %s as %s", (name, type) => {
    expect(resolveFileType(name, BUSINESS)).toBe(type);
  });

  it.each(["payload.exe", "archive.zip", "script.sh", "notes.txt", "page.html", "macro.xlsm"])(
    "rejects %s",
    (name) => {
      expect(resolveFileType(name, BUSINESS)).toBeNull();
    },
  );

  // A file called `csv` with no dot is not a CSV. `split(".").pop()` returns the whole name for one,
  // which without the dot check would match any extension a user happened to name their file.
  it("rejects a name with no extension at all", () => {
    expect(resolveFileType("csv", BUSINESS)).toBeNull();
    expect(resolveFileType("pdf", BUSINESS)).toBeNull();
  });

  it("matches the extension case-insensitively", () => {
    expect(resolveFileType("PRICES.XLSX", BUSINESS)).toBe("xlsx");
    expect(resolveFileType("Quote.PDF", BUSINESS)).toBe("pdf");
  });

  // A double extension is read by its LAST part, which is what the OS and the server both do.
  it("reads only the final extension", () => {
    expect(resolveFileType("payload.csv.exe", BUSINESS)).toBeNull();
    expect(resolveFileType("report.exe.csv", BUSINESS)).toBe("csv");
  });
});

describe("base-document policy (GRN)", () => {
  it.each(["note.pdf", "spec.docx", "pallet.png", "pallet.jpg"])("accepts %s", (name) => {
    expect(resolveFileType(name, BASE)).not.toBeNull();
  });

  // THE assertion that keeps the split a decision. A goods receipt carries what came off the van —
  // a delivery note, a packing slip, a photo of a damaged pallet. Not a workbook.
  it.each(["packing.csv", "packing.xls", "packing.xlsx"])("does not accept %s", (name) => {
    expect(resolveFileType(name, BASE)).toBeNull();
  });
});

describe("accept strings and help text are derived from one list", () => {
  it("offers exactly the extensions the gate accepts", () => {
    for (const ext of BUSINESS) expect(resolveFileType(`file.${ext}`, BUSINESS)).not.toBeNull();
    for (const ext of BASE) expect(resolveFileType(`file.${ext}`, BASE)).not.toBeNull();
  });

  it("writes the accept string as dotted extensions", () => {
    expect(BUSINESS_DOC_ACCEPT).toBe(".pdf,.docx,.xlsx,.xls,.csv,.png,.jpg,.jpeg");
    expect(BASE_DOC_ACCEPT).toBe(".pdf,.docx,.png,.jpg,.jpeg");
  });

  // The sentence is the part that goes stale, because nothing fails when it disagrees with the list
  // beside it. Deriving it is what makes "PDF, DOCX, PNG or JPG" impossible to leave behind.
  it("reads the label back as prose without duplicating JPEG", () => {
    expect(BUSINESS_DOC_LABEL).toBe("PDF, DOCX, XLSX, XLS, CSV, PNG or JPG");
    expect(BASE_DOC_LABEL).toBe("PDF, DOCX, PNG or JPG");
  });

  it("names every accepted format in the label", () => {
    for (const ext of BUSINESS) {
      if (ext === "jpeg") continue; // same format as jpg — naming both reads as two choices
      expect(BUSINESS_DOC_LABEL).toContain(ext.toUpperCase());
    }
  });
});

describe("media types declared to the server", () => {
  // `File.type` comes from the OS and cannot be trusted to describe the file: a machine with no
  // Office install reports "" for a .docx, and Windows reports application/vnd.ms-excel for a .csv
  // when Excel is the registered handler — which would declare a text file as a binary workbook and
  // fail its OLE2 magic-byte check at finalize. So the extension decides.
  it.each([
    ["csv", "text/csv"],
    ["xls", "application/vnd.ms-excel"],
    ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["pdf", "application/pdf"],
    ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ])("declares .%s as %s", (ext, media) => {
    expect(EXT_MEDIA_TYPE[ext]).toBe(media);
  });

  // A CSV and an XLS must never collapse onto one media type: they take different content checks on
  // the server (a text sweep vs an OLE2 signature), so conflating them fails one of the two.
  it("keeps CSV and XLS distinct", () => {
    expect(EXT_MEDIA_TYPE.csv).not.toBe(EXT_MEDIA_TYPE.xls);
  });

  // Every extension any surface offers needs BOTH a fileType (what the attachment row records) and a
  // media type (what the signature is minted for). A gap in either is a file the picker accepts and
  // the upload then cannot describe.
  it("gives every offered extension a file type and a media type", () => {
    for (const ext of new Set([...BUSINESS, ...BASE])) {
      expect(EXT_FILE_TYPE[ext], `${ext} has no fileType`).toBeTruthy();
      expect(EXT_MEDIA_TYPE[ext], `${ext} has no media type`).toBeTruthy();
    }
  });

  it("records jpeg and jpg as one format", () => {
    expect(EXT_FILE_TYPE.jpeg).toBe(EXT_FILE_TYPE.jpg);
  });
});

describe("allowedFrom", () => {
  it("strips the dots and lowercases", () => {
    expect(allowedFrom(".PDF, .Csv")).toEqual(new Set(["pdf", "csv"]));
  });

  it("ignores empty segments rather than allowing a blank extension", () => {
    expect(allowedFrom(".pdf,,")).toEqual(new Set(["pdf"]));
  });
});
