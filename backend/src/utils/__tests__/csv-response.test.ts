import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";

import { EXPORT_CAPPED_HEADER, sendCsv } from "../csv-response.js";

// The four things every export has to get right on the wire. Each was hand-rolled per module before
// this helper existed, and two of the four fail SILENTLY when they are missed:
//
//   · a missing BOM is invisible until a row contains an accented character
//   · a missing/renamed capped header reads as `false` on the client, so a truncated file is
//     presented as the whole answer
//
// Asserting them here is what lets every new export inherit them by calling one function.
const mockRes = () => {
  const headers: Record<string, string> = {};
  const body: string[] = [];
  const res = {
    setHeader: vi.fn((k: string, v: string) => {
      headers[k] = v;
    }),
    send: vi.fn((b: string) => {
      body.push(b);
    }),
  } as unknown as Response;
  return { res, headers, body };
};

describe("sendCsv", () => {
  it("sends it as a download, named and dated", () => {
    const { res, headers } = mockRes();
    sendCsv(res, "purchase-orders", { csv: "a,b", capped: false });
    expect(headers["Content-Type"]).toBe("text/csv; charset=utf-8");
    expect(headers["Content-Disposition"]).toMatch(/^attachment; filename="purchase-orders-\d{4}-\d{2}-\d{2}\.csv"$/);
  });

  // Excel reads a BOM-less UTF-8 file as the local codepage, so "Müller" arrives mangled. Prepended
  // here rather than by callers precisely because nobody notices its absence in testing.
  it("prepends the UTF-8 BOM Excel needs", () => {
    const { res, body } = mockRes();
    sendCsv(res, "x", { csv: "name\r\nMüller", capped: false });
    expect(body[0]!.startsWith("﻿")).toBe(true);
    expect(body[0]).toBe("﻿name\r\nMüller");
  });

  it("flags a truncated export", () => {
    const { res, headers } = mockRes();
    sendCsv(res, "x", { csv: "a", capped: true });
    expect(headers[EXPORT_CAPPED_HEADER]).toBe("true");
  });

  // Absent, not "false": the client tests the header's presence, and a literal "false" would be a
  // truthy string in any caller that forgot to compare it.
  it("omits the flag entirely when the export is complete", () => {
    const { res, headers } = mockRes();
    sendCsv(res, "x", { csv: "a", capped: false });
    expect(headers).not.toHaveProperty(EXPORT_CAPPED_HEADER);
  });

  // ONE name for every export. Bespoke per-module names are what made the CORS allow-list grow with
  // the export count — and a forgotten entry there strips the header with no error anywhere.
  it("uses the single canonical header name", () => {
    expect(EXPORT_CAPPED_HEADER).toBe("X-Export-Capped");
  });
});
