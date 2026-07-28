import { describe, expect, it } from "vitest";

import { NAV } from "./Sidebar";
import { DASHBOARD_SECTIONS } from "@/lib/auth";

// The nav rail and the post-login landing list are two hand-maintained tables describing the same
// thing: which permissions open which page. auth.ts says they are "kept in lockstep" — but nothing
// enforced it, and they silently drifted when the customer stock-category master moved out of
// Settings into the Customers module. The two failure modes that produced:
//
//   • nav perms ⊃ landing perms → a link appears that the page's own gate then rejects (dead link);
//   • landing perms ⊃ nav perms → the user is dropped on a page with no way back to it.
//
// So: for every path both tables describe, the permission sets must be identical. Paths only one
// table knows about are legitimate (e.g. /dashboard/purchase-requests has a nav entry but no
// landing slot; /dashboard/goods-in is reachable by deep link with its nav shortcut removed) and
// are left alone.

const permsByPath = (pairs: { path: string; perms: string[] }[]) =>
  new Map(pairs.map((p) => [p.path, [...p.perms].sort()]));

const navPerms = permsByPath(NAV.map((n) => ({ path: n.href, perms: n.perms })));
const landingPerms = permsByPath(DASHBOARD_SECTIONS.map((s) => ({ path: s.path, perms: s.anyOf })));

describe("Sidebar NAV ↔ DASHBOARD_SECTIONS lockstep", () => {
  const shared = [...navPerms.keys()].filter((path) => landingPerms.has(path));

  it("describes a meaningful number of shared paths (guards against a vacuous pass)", () => {
    // If a refactor renames the tables' keys apart, `shared` silently empties and every assertion
    // below passes without checking anything. Pin a floor so that failure is loud.
    expect(shared.length).toBeGreaterThanOrEqual(8);
  });

  it.each(shared)("%s grants the same permissions in the nav as in the landing list", (path) => {
    expect(navPerms.get(path)).toEqual(landingPerms.get(path));
  });

  it("keeps the customer stock-category master reachable from the Customers item", () => {
    // The regression that motivated this file: categories.view must open Customers (its screen is a
    // tab there) and must NOT open Settings (its section was removed from SettingsPanel).
    expect(navPerms.get("/dashboard/customers")).toContain("categories.view");
    expect(navPerms.get("/dashboard/settings")).not.toContain("categories.view");
  });

  it("never lists a permission in the nav that its page's landing slot rejects", () => {
    // Restates the lockstep as the user-visible symptom, so a failure reads as "dead link".
    for (const path of shared) {
      for (const perm of navPerms.get(path) ?? []) {
        expect(landingPerms.get(path)).toContain(perm);
      }
    }
  });
});
