import { describe, expect, it } from "vitest";

import { listCacheKey as grnKey } from "./goods-in.service";
import { listCacheKey as jobKey } from "./job.service";
import { listCacheKey as poKey } from "./purchase-order.service";
import { listCacheKey as prfKey } from "./purchase-request.service";
import { listCacheKey as userKey } from "./user.service";

// ── Cache identity ─────────────────────────────────────────────────────────────────────────────
//
// A list cache keyed by less than the full request is a SILENT WRONG ANSWER: two filter states
// collapse onto one entry, so a filtered response is served for an unfiltered request and the
// unfiltered page is overwritten by a filtered one.
//
// Goods In shipped exactly that — `receivedFrom` / `receivedTo` were sent to the API and appeared in
// no key. The key is now derived from the query string, so a parameter is in the key BECAUSE it is
// in the request. Every case below fails against the old hand-written key.

/** Assert that a set of parameter objects all map to DIFFERENT cache slots. */
function allDistinct<T>(key: (p: T) => string, sets: Record<string, T>): void {
  const seen = new Map<string, string>();
  for (const [name, params] of Object.entries(sets)) {
    const k = key(params as T);
    const clash = seen.get(k);
    expect(clash, `"${name}" and "${clash}" share cache key ${JSON.stringify(k)}`).toBeUndefined();
    seen.set(k, name);
  }
}

describe("Goods In — the key that was wrong", () => {
  it("does NOT reuse the unfiltered entry for a date-filtered request", () => {
    // The exact regression: identical but for the date window. These produced the SAME key before.
    expect(grnKey({ page: 1, pageSize: 20 })).not.toBe(
      grnKey({ page: 1, pageSize: 20, receivedFrom: "2026-08-01", receivedTo: "2026-08-31" }),
    );
  });

  it("separates two different date ranges", () => {
    expect(grnKey({ page: 1, receivedFrom: "2026-08-01", receivedTo: "2026-08-31" })).not.toBe(
      grnKey({ page: 1, receivedFrom: "2026-07-01", receivedTo: "2026-07-31" }),
    );
  });

  it("separates an open-ended range from its closed and inverted forms", () => {
    allDistinct(grnKey, {
      fromOnly: { page: 1, receivedFrom: "2026-08-01" },
      toOnly: { page: 1, receivedTo: "2026-08-01" },
      both: { page: 1, receivedFrom: "2026-08-01", receivedTo: "2026-08-01" },
      neither: { page: 1 },
    });
  });

  it("separates every other response-affecting parameter", () => {
    allDistinct(grnKey, {
      plain: { page: 1 },
      status: { page: 1, status: "draft" },
      warehouse: { page: 1, warehouse: "wh1" },
      otherWarehouse: { page: 1, warehouse: "wh2" },
      supplier: { page: 1, supplier: "sup1" },
      purchaseOrder: { page: 1, purchaseOrder: "po1" },
      search: { page: 1, search: "GRN-1" },
      sort: { page: 1, sort: "oldest" },
      page2: { page: 2 },
      biggerPage: { page: 1, pageSize: 50 },
    });
  });

  it("CLEARING a filter returns to the unfiltered key, not a third slot", () => {
    // Clearing a date box sets the param to undefined, which must land back on the original entry —
    // otherwise the restored view would miss its own cached page and flash a skeleton.
    const unfiltered = grnKey({ page: 1, pageSize: 20 });
    const filtered = grnKey({ page: 1, pageSize: 20, receivedFrom: "2026-08-01" });
    const cleared = grnKey({ page: 1, pageSize: 20, receivedFrom: undefined, receivedTo: undefined });
    expect(filtered).not.toBe(unfiltered);
    expect(cleared).toBe(unfiltered);
  });

  it("is stable — the same filters always serialise identically", () => {
    const a = grnKey({ page: 1, status: "draft", warehouse: "wh1", receivedFrom: "2026-08-01" });
    const b = grnKey({ page: 1, status: "draft", warehouse: "wh1", receivedFrom: "2026-08-01" });
    expect(a).toBe(b);
  });
});

describe("the same rule holds on every list this pass touched", () => {
  it("Jobs — due window, created window, site, priority, project", () => {
    allDistinct(jobKey, {
      plain: { page: 1 },
      due: { page: 1, dueFrom: "2026-08-01", dueTo: "2026-08-31" },
      otherDue: { page: 1, dueFrom: "2026-07-01", dueTo: "2026-07-31" },
      created: { page: 1, createdFrom: "2026-08-01", createdTo: "2026-08-31" },
      site: { page: 1, site: "site1" },
      priority: { page: 1, priority: "urgent" },
      project: { page: 1, project: "proj1" },
      engineer: { page: 1, engineer: "eng1" },
      customer: { page: 1, customer: "cust1" },
    });
  });

  it("Purchase Orders — the two date windows are not interchangeable", () => {
    allDistinct(poKey, {
      plain: { page: 1 },
      ordered: { page: 1, orderedFrom: "2026-08-01", orderedTo: "2026-08-31" },
      // Same dates, DIFFERENT column. A key built from values alone would collide here.
      expected: { page: 1, expectedFrom: "2026-08-01", expectedTo: "2026-08-31" },
      supplier: { page: 1, supplier: "s1" },
      warehouse: { page: 1, warehouse: "w1" },
      priority: { page: 1, priority: "urgent" },
      statuses: { page: 1, statuses: ["sent", "approved"] },
    });
  });

  it("Purchase Requests — required-by vs quote-valid windows", () => {
    allDistinct(prfKey, {
      plain: { page: 1 },
      required: { page: 1, requiredFrom: "2026-08-01", requiredTo: "2026-08-31" },
      valid: { page: 1, validFrom: "2026-08-01", validTo: "2026-08-31" },
    });
  });

  it("Users — the added-date window", () => {
    allDistinct(userKey, {
      plain: { page: 1 },
      added: { page: 1, addedFrom: "2026-07-01", addedTo: "2026-07-31" },
      role: { page: 1, roleId: "r1" },
    });
  });
});
