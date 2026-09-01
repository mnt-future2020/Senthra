import { describe, expect, it } from "vitest";

import {
  MAX_IDS_PER_LOOKUP,
  catalogueSearchView,
  chunkIds,
  matchesAnyField,
  mergeById,
  missingIds,
  shouldOfferCreate,
} from "./cataloguePicker";

/**
 * The core shared by the IRM and rental pickers. The IRM model has its own suite exercising these
 * through its bindings; this one pins the generic behaviour directly, using a rental-shaped row so
 * a regression shows up here rather than only in one catalogue's tests.
 */

type Row = { id: string; name: string; code: string; description?: string | null };
const row = (id: string, name: string, code = `R-${id}`, description: string | null = null): Row => ({
  id,
  name,
  code,
  description,
});

const matchesRow = (r: Row, q: string) => matchesAnyField([r.name, r.code, r.description], q);

describe("matchesAnyField", () => {
  it("matches any listed field, case-insensitively", () => {
    expect(matchesAnyField(["Scissor Lift", "R-01", null], "scissor")).toBe(true);
    expect(matchesAnyField(["Scissor Lift", "R-01", null], "r-01")).toBe(true);
  });

  it("treats a blank query as no filter, and survives null fields", () => {
    expect(matchesAnyField([null, undefined], "")).toBe(true);
    expect(matchesAnyField([null, undefined], "x")).toBe(false);
  });
});

describe("mergeById", () => {
  const a = row("a", "A");
  const b = row("b", "B");

  it("appends unseen rows and replaces known ones in place", () => {
    expect(mergeById([a], [b]).map((r) => r.id)).toEqual(["a", "b"]);
    const merged = mergeById([a, b], [row("a", "A renamed")]);
    expect(merged.map((r) => r.id)).toEqual(["a", "b"]);
    expect(merged[0].name).toBe("A renamed");
  });

  // Pickers merge on every response; a fresh array each time re-renders every line of the caller.
  it("returns the same array when nothing changed", () => {
    const existing = [a, b];
    expect(mergeById(existing, [a])).toBe(existing);
    expect(mergeById(existing, [])).toBe(existing);
  });
});

describe("missingIds", () => {
  it("names only what is not held, ignoring blanks and duplicates", () => {
    expect(missingIds(["a", "", null, undefined, "c", "c"], [row("a", "A")])).toEqual(["c"]);
  });
});

describe("shouldOfferCreate", () => {
  const settled = { canCreate: true, query: "Scissor", searching: false, searchFailed: false, resultCount: 0 };

  it("offers create once a search settles with no match", () => {
    expect(shouldOfferCreate(settled)).toBe(true);
  });

  it("never offers without permission", () => {
    expect(shouldOfferCreate({ ...settled, canCreate: false })).toBe(false);
  });

  // Mid-search the count is still 0 — offering here invites a duplicate of the row about to arrive.
  it("stays silent while searching, and after a failure", () => {
    expect(shouldOfferCreate({ ...settled, searching: true })).toBe(false);
    expect(shouldOfferCreate({ ...settled, searchFailed: true })).toBe(false);
  });

  it("stays silent when matches exist or the query is too short", () => {
    expect(shouldOfferCreate({ ...settled, resultCount: 2 })).toBe(false);
    expect(shouldOfferCreate({ ...settled, query: " s " })).toBe(false);
  });
});

describe("catalogueSearchView", () => {
  const seed = [row("1", "Scissor Lift"), row("2", "Tower Scaffold")];
  const hit = row("9", "Scissor Lift 12m");

  // A single character still narrows locally, with no round trip.
  it("filters the caller's own page below the search threshold", () => {
    expect(catalogueSearchView("w", null, seed, matchesRow).options.map((r) => r.id)).toEqual(["2"]);
    expect(catalogueSearchView("", null, seed, matchesRow).options).toHaveLength(2);
  });

  it("is searching past the threshold until an answer for THAT query arrives", () => {
    expect(catalogueSearchView("scissor", null, seed, matchesRow).searching).toBe(true);
    const stale = { query: "sciss", items: [hit], failed: false };
    expect(catalogueSearchView("scissor", stale, seed, matchesRow).searching).toBe(true);
  });

  it("shows the server's answer for the query on screen", () => {
    const v = catalogueSearchView("scissor", { query: "scissor", items: [hit], failed: false }, seed, matchesRow);
    expect(v.options).toEqual([hit]);
    expect(v.searching).toBe(false);
  });

  it("reports a failure as a failure, not as an empty catalogue", () => {
    const v = catalogueSearchView("scissor", { query: "scissor", items: [], failed: true }, seed, matchesRow);
    expect(v.searchFailed).toBe(true);
    expect(v.excludedCount).toBe(0);
  });

  it("applies a caller's exclusion rule to seed and results alike, and counts it", () => {
    const notTower = (r: Row) => !r.name.includes("Tower");
    expect(catalogueSearchView("", null, seed, matchesRow, notTower).excludedCount).toBe(1);
    const v = catalogueSearchView("tower", { query: "tower", items: [row("2", "Tower Scaffold")], failed: false }, [], matchesRow, notTower);
    expect(v.options).toEqual([]);
    expect(v.excludedCount).toBe(1);
  });
});

/**
 * Identity, not resemblance.
 *
 * Catalogue names are not unique — two rental items may both be called "Fiber Tester". Every helper
 * a picker uses to decide "which row is selected" keys on ID, and these tests exist so that stays
 * true: keying any of them by name would silently restore the WRONG item on a saved document.
 */
describe("same name, different id", () => {
  const A = row("aaa", "Fiber Tester", "RNT-0001");
  const B = row("bbb", "Fiber Tester", "RNT-0002");

  it("merge keeps both rather than collapsing them into one", () => {
    const merged = mergeById([A], [B]);
    expect(merged).toHaveLength(2);
    expect(merged.map((r) => r.id)).toEqual(["aaa", "bbb"]);
  });

  it("merge replaces only the row with the SAME id", () => {
    const merged = mergeById([A, B], [{ ...A, code: "RNT-0001-renamed" }]);
    expect(merged).toHaveLength(2);
    expect(merged.find((r) => r.id === "aaa")?.code).toBe("RNT-0001-renamed");
    expect(merged.find((r) => r.id === "bbb")?.code).toBe("RNT-0002");
  });

  it("a held row does not satisfy the OTHER id's lookup", () => {
    // Holding A must still cause B to be fetched, despite the identical name.
    expect(missingIds(["bbb"], [A])).toEqual(["bbb"]);
    expect(missingIds(["aaa"], [A])).toEqual([]);
  });

  it("selecting by id picks the intended row even when the search matched both", () => {
    const view = catalogueSearchView("fiber", { query: "fiber", items: [A, B], failed: false }, [], matchesRow);
    expect(view.options).toHaveLength(2);
    expect(view.options.find((r) => r.id === "bbb")).toBe(B);
  });
});

/**
 * One id lookup is bounded on the SERVER (sanitiseIrmIds / sanitiseRentalIds cap it, and the page
 * cap is raised to exactly that bound). Asking for more in a single request does not fail — it comes
 * back short, with nothing to say so. Splitting here is what keeps a caller with more ids than the
 * bound honest: every id is asked for, in as few requests as that allows.
 */
describe("chunkIds", () => {
  it("leaves a list within the bound as one request", () => {
    expect(chunkIds(["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });

  it("splits a list past the bound so no id is silently dropped", () => {
    const ids = Array.from({ length: MAX_IDS_PER_LOOKUP + 30 }, (_, i) => `id-${i}`);
    const batches = chunkIds(ids);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(MAX_IDS_PER_LOOKUP);
    expect(batches[1]).toHaveLength(30);
    expect(batches.flat()).toEqual(ids); // every id asked for, exactly once, in order
  });

  it("asks for nothing when there is nothing to ask for", () => {
    expect(chunkIds([])).toEqual([]);
  });

  // The bound has to match the server's, or chunking just moves the truncation.
  it("bounds a batch at the size the server will actually return", () => {
    expect(MAX_IDS_PER_LOOKUP).toBe(200);
  });
});

/**
 * The create-offer must count what the SERVER matched, not what survived the caller's own filter.
 *
 * A picker with a `filterItem` rule (stock adjustment only handles some items) can end up with an
 * empty `options` list while the catalogue plainly holds a match — it was excluded, not absent.
 * Offering "add this as a new item" there invites a duplicate of a row that already exists, which is
 * the exact failure `shouldOfferCreate` was written to prevent.
 */
describe("catalogueSearchView matchCount", () => {
  const rows = [
    { id: "a", name: "Serial Router", code: "IRM-1" },
    { id: "b", name: "Plain Cable", code: "IRM-2" },
  ];
  const matches = (r: { name: string; code: string }, q: string) => matchesAnyField([r.name, r.code], q);
  const settled = { query: "router", items: [rows[0]], failed: false };

  it("counts a match the caller's rule excluded", () => {
    const view = catalogueSearchView("router", settled, [], matches, (r) => r.id !== "a");
    expect(view.options).toHaveLength(0);
    expect(view.excludedCount).toBe(1);
    // The number the create-offer must see: the catalogue DOES hold a match.
    expect(view.matchCount).toBe(1);
  });

  it("equals the visible options when nothing is excluded", () => {
    const view = catalogueSearchView("router", settled, [], matches);
    expect(view.matchCount).toBe(view.options.length);
    expect(view.matchCount).toBe(1);
  });

  it("is zero when the catalogue genuinely has nothing", () => {
    const view = catalogueSearchView("nothing", { query: "nothing", items: [], failed: false }, [], matches);
    expect(view.matchCount).toBe(0);
  });
});
