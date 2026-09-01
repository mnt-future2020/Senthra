import { describe, expect, it, vi } from "vitest";

// listRentalItems is exercised below for its PAGING rule alone, so the repository is stubbed down to
// the one read that rule depends on. Everything else in this file is pure.
vi.mock("./rental-item.repository.js", () => ({
  findMany: vi.fn(async () => ({ items: [], total: 500 })),
}));

import { MAX_RENTAL_IDS, listRentalItems, sanitiseRentalIds } from "./rental-item.service.js";

const oid = (n: number) => n.toString(16).padStart(24, "0");

describe("sanitiseRentalIds", () => {
  it("keeps well-formed ObjectIds", () => {
    expect(sanitiseRentalIds([oid(1), oid(2)])).toEqual([oid(1), oid(2)]);
  });

  // A malformed id reaching Prisma's `in` throws P2023 — a 500 on a query the caller could not
  // have known was bad. Dropped here instead.
  it("drops anything that is not an ObjectId", () => {
    expect(sanitiseRentalIds(["", "abc", "../../etc/passwd", "0".repeat(23), "z".repeat(24)])).toEqual([]);
  });

  it("de-duplicates so a repeated id is asked for once", () => {
    expect(sanitiseRentalIds([oid(1), oid(1), oid(2)])).toEqual([oid(1), oid(2)]);
  });

  it("bounds the list so one request cannot sweep the catalogue", () => {
    const many = Array.from({ length: MAX_RENTAL_IDS + 25 }, (_, i) => oid(i + 1));
    expect(sanitiseRentalIds(many)).toHaveLength(MAX_RENTAL_IDS);
  });

  /**
   * The load-bearing case. An empty array becomes `id: { in: [] }`, which matches nothing — whereas
   * `undefined` would DROP the filter and answer a lookup for bogus ids with the whole first page.
   */
  it("returns an empty list — never undefined — when nothing valid was asked for", () => {
    const out = sanitiseRentalIds(["nonsense"]);
    expect(out).toEqual([]);
    expect(out).not.toBeUndefined();
  });
});

/**
 * The client splits an id lookup into batches of `MAX_IDS_PER_LOOKUP` (frontend lib/cataloguePicker)
 * because one oversized request does not FAIL — it comes back short, and a short page is
 * indistinguishable from a complete one. That only holds while the batch size the client sends and
 * the page the server will actually return are the same number.
 *
 * Both catalogues therefore bound a lookup at 200: IRM raises its page cap to MAX_IRM_IDS for an id
 * lookup, and rental's own paging already defaults to 200. Change one of these three and the
 * truncation comes back silently, which is why it is asserted rather than left as a coincidence.
 */
describe("id-lookup bounds stay aligned with the client's batch size", () => {
  it("bounds one rental lookup at the size the client sends", () => {
    expect(MAX_RENTAL_IDS).toBe(200);
  });

  it("returns a full batch rather than clamping it to an ordinary page", async () => {
    const ids = Array.from({ length: MAX_RENTAL_IDS }, (_, i) => oid(i + 1));
    const page = await listRentalItems({ ids, pageSize: ids.length });
    expect(page.pageSize).toBe(MAX_RENTAL_IDS);
  });
});
