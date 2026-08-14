import { describe, expect, it } from "vitest";

import { EXPORT_MAX, EXPORT_PAGING } from "../csv.js";
import { paginate } from "../pagination.js";

describe("paginate", () => {
  it("defaults to 20 rows when no size is asked for", () => {
    expect(paginate(undefined, undefined, 500).pageSize).toBe(20);
  });

  it("clamps a client's page size to 100", () => {
    expect(paginate(1, 5_000, 10_000).pageSize).toBe(100);
  });

  it("floors a page size below 1", () => {
    expect(paginate(1, 0, 10).pageSize).toBe(1);
    expect(paginate(1, -7, 10).pageSize).toBe(1);
  });

  it("clamps an out-of-range page to the last one", () => {
    expect(paginate(99, 20, 50).page).toBe(3);
    expect(paginate(0, 20, 50).page).toBe(1);
  });

  it("treats an empty list as page 1 of 1", () => {
    const { page, totalPages, skip } = paginate(1, 20, 0);
    expect({ page, totalPages, skip }).toEqual({ page: 1, totalPages: 1, skip: 0 });
  });

  it("derives skip from the CLAMPED size, not the requested one", () => {
    // Page 2 of a request for 5,000 rows is row 100, not row 5,000 — otherwise a clamped page size
    // and an unclamped offset would skip 4,900 rows nobody ever saw.
    expect(paginate(2, 5_000, 10_000).skip).toBe(100);
  });

  /**
   * The bug this argument exists for. Every CSV export delegates to a list function so it inherits
   * that list's filter semantics, and asks for one oversized page. Without a raised cap the request
   * was clamped to 100, so each export produced a 100-row file — and because `capped` is measured on
   * the same clamped length, the file reported itself COMPLETE. A silently truncated download is
   * worse than a refused one, so these pin the cap from both sides.
   */
  describe("maxPageSize", () => {
    it("honours a server-initiated cap above the client ceiling", () => {
      expect(paginate(1, EXPORT_MAX + 1, 200_000, EXPORT_MAX + 1).pageSize).toBe(EXPORT_MAX + 1);
    });

    it("still clamps to whatever cap was given", () => {
      expect(paginate(1, 999_999, 200_000, EXPORT_MAX + 1).pageSize).toBe(EXPORT_MAX + 1);
    });

    it("keeps the 100 ceiling when no cap is passed", () => {
      expect(paginate(1, EXPORT_MAX + 1, 200_000).pageSize).toBe(100);
    });

    it("EXPORT_PAGING carries a cap that matches the size it asks for", () => {
      // The two have to move together: pageSize is what gets requested, maxPageSize is what allows
      // it. Setting one without the other is exactly how the truncation went unnoticed.
      expect(EXPORT_PAGING.maxPageSize).toBe(EXPORT_PAGING.pageSize);
      expect(paginate(EXPORT_PAGING.page, EXPORT_PAGING.pageSize, 200_000, EXPORT_PAGING.maxPageSize).pageSize)
        .toBe(EXPORT_MAX + 1);
    });

    it("asks for one row MORE than the cap, so truncation is detectable", () => {
      // `capped` is `rows.length > EXPORT_MAX`. That comparison can only ever be true if the fetch
      // was allowed to return EXPORT_MAX + 1.
      expect(EXPORT_PAGING.pageSize).toBe(EXPORT_MAX + 1);
    });
  });
});
