import { describe, expect, it } from "vitest";

import { classifyRows, dedupeKey, mapColumns, validateRow } from "./siteImport";

describe("mapColumns", () => {
  it("maps aliases case-insensitively and trims", () => {
    const d = mapColumns({ "Site Name": " Leeds HQ ", "Post Code": "ls1 4dy", Town: "Leeds", Phone: "0770" });
    expect(d.name).toBe("Leeds HQ");
    expect(d.postcode).toBe("ls1 4dy");
    expect(d.city).toBe("Leeds");
    expect(d.contactNumber).toBe("0770");
  });
  it("defaults country and status when blank", () => {
    const d = mapColumns({ name: "A" });
    expect(d.country).toBe("United Kingdom");
    expect(d.status).toBe("active");
  });
});

describe("validateRow", () => {
  it("requires a name", () => {
    expect(validateRow(mapColumns({ name: "" })).ok).toBe(false);
  });
  it("rejects a bad UK postcode", () => {
    expect(validateRow(mapColumns({ name: "A", postcode: "12345" })).ok).toBe(false);
  });
  it("accepts a valid row and emits a SitePayload with defaults applied", () => {
    const r = validateRow(mapColumns({ name: "A", postcode: "LS1 4DY" }));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("A");
      expect(r.value.country).toBe("United Kingdom");
      expect(r.value.status).toBe("active");
    }
  });
  it("rejects an out-of-range status", () => {
    expect(validateRow(mapColumns({ name: "A", status: "archived" })).ok).toBe(false);
  });
  it("rejects a postcode over 12 chars even if the shape matches (mirrors backend max(12))", () => {
    const r = validateRow(mapColumns({ name: "A", postcode: "M1        1AA" }));
    expect(r.ok).toBe(false);
  });
  it("rejects a contactPerson over 120 chars (mirrors backend max(120))", () => {
    const r = validateRow(mapColumns({ name: "A", contactPerson: "x".repeat(121) }));
    expect(r.ok).toBe(false);
  });
  it("rejects a phone that lost its leading 0 (spreadsheet numeric coercion) but accepts +44 form", () => {
    expect(validateRow(mapColumns({ name: "A", contactNumber: "7700900123" })).ok).toBe(false);
    expect(validateRow(mapColumns({ name: "A", contactNumber: "+44 7700 900123" })).ok).toBe(true);
  });
  // The server normalises what it stores; the preview must show the SAME thing, or the user
  // approves "ls14dy" and a different string lands in the DB.
  it("emits the canonical postcode, however the spreadsheet spelled it", () => {
    const r = validateRow(mapColumns({ name: "A", postcode: "ls14dy" }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.postcode).toBe("LS1 4DY");
  });
});

describe("dedupeKey", () => {
  it("is case- and space-insensitive on name + postcode", () => {
    expect(dedupeKey("Leeds HQ", "LS1 4DY")).toBe(dedupeKey("leeds hq", "ls14dy"));
  });
});

describe("classifyRows", () => {
  it("tags error > duplicate > new and catches in-file duplicates", () => {
    const drafts = [
      mapColumns({ name: "Good", postcode: "LS1 4DY" }),   // new
      mapColumns({ name: "Good", postcode: "ls1 4dy" }),   // duplicate (in-file)
      mapColumns({ name: "Dupe", postcode: "M1 1AA" }),    // duplicate (existing)
      mapColumns({ name: "", postcode: "M1 1AA" }),        // error
    ];
    const existing = new Set([dedupeKey("Dupe", "M1 1AA")]);
    const rows = classifyRows(drafts, existing);
    expect(rows.map((r) => r.status)).toEqual(["new", "duplicate", "duplicate", "error"]);
    expect(rows[0].rowNumber).toBe(1);
  });
});
