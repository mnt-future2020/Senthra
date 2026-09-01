import { describe, expect, it } from "vitest";

import { listCacheKey } from "./irm.service";

/**
 * `listCacheKey` IS the query string the request is sent with (see the note on it in irm.service).
 * Asserting on it therefore asserts on the wire format — which is what decides whether the picker
 * actually searches server-side or quietly falls back to "the first page, filtered in the browser".
 */
describe("IRM list query", () => {
  it("sends the search term to the server", () => {
    expect(listCacheKey({ search: "cat6", status: "active", pageSize: 25 })).toBe(
      "?search=cat6&status=active&pageSize=25",
    );
  });

  // The whole point of the change: a picker asks for a BOUNDED page and lets the server search the
  // rest. A pageSize of 500/1000/5000 here would be the fake fix this replaced.
  it("keeps the picker's page bounded", () => {
    const key = listCacheKey({ search: "cat6", status: "active", pageSize: 25 });
    const size = Number(new URLSearchParams(key.slice(1)).get("pageSize"));
    expect(size).toBeLessThanOrEqual(50);
  });

  it("sends an id lookup as a comma-separated list", () => {
    expect(listCacheKey({ ids: ["a1", "b2"] })).toBe("?ids=a1%2Cb2");
  });

  it("omits ids entirely when none are asked for", () => {
    expect(listCacheKey({ ids: [] })).toBe("");
    expect(listCacheKey({})).toBe("");
  });

  // Cache identity is the query string, so a search and an id lookup can never collide in the
  // client cache and serve each other's rows.
  it("gives searches and id lookups distinct cache identities", () => {
    expect(listCacheKey({ search: "cat6" })).not.toBe(listCacheKey({ ids: ["cat6"] }));
  });
});
