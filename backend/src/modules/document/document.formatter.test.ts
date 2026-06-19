import { describe, expect, it } from "vitest";

import { formatDate, formatDateTime, formatMoney } from "./document.formatter.js";

describe("formatMoney", () => {
  it("formats GBP integer pence with thousands separators", () => {
    expect(formatMoney(123456, "GBP")).toBe("£1,234.56");
  });
  it("formats EUR pence", () => {
    expect(formatMoney(5000, "EUR")).toBe("€50.00");
  });
  it("handles zero, nullish and single-penny values", () => {
    expect(formatMoney(0, "GBP")).toBe("£0.00");
    expect(formatMoney(null)).toBe("£0.00");
    expect(formatMoney(undefined)).toBe("£0.00");
    expect(formatMoney(1, "GBP")).toBe("£0.01");
  });
});

describe("formatDate", () => {
  const d = new Date("2026-06-19T10:30:00Z");
  it("defaults to DD/MM/YYYY", () => {
    expect(formatDate(d)).toBe("19/06/2026");
  });
  it("supports MM/DD/YYYY and YYYY-MM-DD", () => {
    expect(formatDate(d, "MM/DD/YYYY")).toBe("06/19/2026");
    expect(formatDate(d, "YYYY-MM-DD")).toBe("2026-06-19");
  });
  it("accepts an ISO string and returns empty for blank/invalid", () => {
    expect(formatDate("2026-01-02T00:00:00Z")).toBe("02/01/2026");
    expect(formatDate(null)).toBe("");
    expect(formatDate("not-a-date")).toBe("");
  });
});

describe("formatDateTime", () => {
  it("formats date + 24h time in the configured timezone (BST)", () => {
    const r = { dateFormat: "DD/MM/YYYY", timeFormat: "24h", timezone: "Europe/London" };
    expect(formatDateTime("2026-06-19T10:30:00Z", r)).toBe("19/06/2026 11:30");
  });
  it("returns empty for blank input", () => {
    const r = { dateFormat: "DD/MM/YYYY", timeFormat: "24h", timezone: "Europe/London" };
    expect(formatDateTime(null, r)).toBe("");
  });
});
