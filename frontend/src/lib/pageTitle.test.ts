import { describe, expect, it } from "vitest";

import { resolvePageTitle } from "./pageTitle";
import { CUSTOMER_NAV, ENGINEER_NAV, NAV } from "@/components/dashboard/shell/Sidebar";

// The top bar is now the ONLY place a page says what it is — the per-page title card that used to
// cover for it is gone. A nav entry with no matching title would therefore read "Dashboard" in
// production, which is exactly the state this replaced (five titles against twenty routes). Same
// guard-rail idea as Sidebar.nav.test.ts: the two hand-maintained tables must agree.
describe("every sidebar destination has its own title", () => {
  for (const [group, nav] of [
    ["admin", NAV],
    ["customer", CUSTOMER_NAV],
    ["engineer", ENGINEER_NAV],
  ] as const) {
    it(`${group} nav`, () => {
      for (const item of nav) {
        expect(resolvePageTitle(item.href), `${item.href} should resolve to "${item.label}"`).toBe(item.label);
      }
    });
  }
});

describe("resolvePageTitle", () => {
  it("matches a route exactly", () => {
    expect(resolvePageTitle("/dashboard/jobs")).toBe("Jobs");
    expect(resolvePageTitle("/dashboard")).toBe("Dashboard");
  });

  it("gives a nested route its section's name", () => {
    expect(resolvePageTitle("/dashboard/jobs/new")).toBe("Jobs");
    expect(resolvePageTitle("/dashboard/suppliers/SUP-0001/edit")).toBe("Suppliers");
    expect(resolvePageTitle("/dashboard/irm/IRM-0004")).toBe("IRM Catalogue");
  });

  it("lets a deeper entry win over its parent", () => {
    // Both /dashboard/engineer and /dashboard/engineer/jobs have titles; the longer one applies.
    expect(resolvePageTitle("/dashboard/engineer")).toBe("Dashboard");
    expect(resolvePageTitle("/dashboard/engineer/jobs")).toBe("Jobs");
    expect(resolvePageTitle("/dashboard/engineer/jobs/JOB-0001")).toBe("Jobs");
    expect(resolvePageTitle("/dashboard/portal/requests")).toBe("Stock Submissions");
  });

  it("only matches on a segment boundary", () => {
    // "/dashboard/stock" must not swallow "/dashboard/stock-entries", which is a different module.
    expect(resolvePageTitle("/dashboard/stock")).toBe("My Stock");
    expect(resolvePageTitle("/dashboard/stock-entries/abc123")).toBe("Stock Entry");
  });

  it("ignores a trailing slash", () => {
    expect(resolvePageTitle("/dashboard/jobs/")).toBe("Jobs");
    expect(resolvePageTitle("/dashboard/")).toBe("Dashboard");
  });

  it("keeps the routes that have no nav entry", () => {
    expect(resolvePageTitle("/dashboard/goods-in")).toBe("Goods In");
    expect(resolvePageTitle("/dashboard/roles/new")).toBe("Users & Roles");
  });

  // Both catalogues are reached from the Inventory Hub rather than the rail, so the sidebar sweep
  // above can't catch them. The rental item pages read "Dashboard" until this entry existed.
  it("names the catalogues that live inside the Inventory Hub", () => {
    expect(resolvePageTitle("/dashboard/irm/IRM-0004")).toBe("IRM Catalogue");
    expect(resolvePageTitle("/dashboard/rentals")).toBe("Rental Catalogue");
    expect(resolvePageTitle("/dashboard/rentals/RNT-0004")).toBe("Rental Catalogue");
    expect(resolvePageTitle("/dashboard/rentals/RNT-0004/edit")).toBe("Rental Catalogue");
  });

  // Nested DESTINATIONS, as opposed to nested forms. A form states its own name in its FormScaffold
  // header, so inheriting its section's title costs nothing; a list page has no such header any more,
  // so inheriting means it states its name NOWHERE. Stock movements did exactly that — reached from
  // Inventory, it read "Inventory" in the top bar, identical to the hub it was opened from.
  //
  // The sidebar sweep above cannot catch these: they have no nav entry to compare against. Any list
  // page added under an existing section needs its own entry, and a line here.
  it("gives a nested LIST page its own name rather than its section's", () => {
    expect(resolvePageTitle("/dashboard/inventory")).toBe("Inventory");
    expect(resolvePageTitle("/dashboard/inventory/history")).toBe("Stock movements");
  });

  it("falls back to Dashboard for a route it has never heard of", () => {
    expect(resolvePageTitle("/dashboard/nope")).toBe("Dashboard");
    expect(resolvePageTitle("/somewhere/else")).toBe("Dashboard");
  });
});
