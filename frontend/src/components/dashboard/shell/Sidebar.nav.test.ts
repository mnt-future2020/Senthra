import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

// ── Information architecture: one nav item = one concept ──────────────────────────────────────
//
// The client's flow separates two things the sidebar once conflated:
//   Finance                 → Finance Reports → Report
//   Reports & Audit Trails  → Custom Reports  → Audit Trails
//
// The Finance page was originally shipped as a nav item labelled "Reports", which asserted that all
// reporting is financial. That stops being true the moment a stock, engineer or customer report
// exists — and Custom Reports (FLOW 10B) is exactly that. These tests pin the separation so it cannot
// quietly regress while the Reports hub is being built.
describe("Finance and Reports & Audit are distinct navigation concepts", () => {
  const hrefs = NAV.map((n) => n.href);
  const labels = NAV.map((n) => n.label);

  it("exposes Finance as its own item, gated on the finance permission alone", () => {
    const finance = NAV.find((n) => n.href === "/dashboard/finance");
    expect(finance, "Finance must be its own nav item").toBeDefined();
    expect(finance!.label).toBe("Finance");
    // `reports.view` belongs to the Reports & Audit hub. Listing it here would show a Finance row to
    // somebody who cannot see a single figure on the page.
    expect(finance!.perms).toEqual(["reports.finance.view"]);
  });

  it("exposes Reports & Audit as the general hub, admitting either of its modules", () => {
    const hub = NAV.find((n) => n.href === "/dashboard/reports");
    expect(hub, "Reports & Audit must be its own nav item").toBeDefined();
    expect(hub!.label).toBe("Reports & Audit");
    // Custom Reports (reports.view), Scheduled Reports (either reporting right) and the Audit Trail
    // (audit.view) are tabs behind one door; the hub renders only the tabs the user holds.
    //
    // `reports.finance.view` earns its place here solely because scheduling lives in this hub: a
    // finance-only role must be able to automate the Finance report. Scheduling still introduces NO
    // new permission — which report a user may schedule is decided per report, server-side.
    expect(hub!.perms).toEqual(["reports.view", "reports.finance.view", "audit.view"]);
  });

  // Scheduling automates the reports in this hub, so it is a tab inside it, not a fourth top-level
  // entry. The brief's whole point was that one nav item means one concept.
  it("does not give Scheduled Reports a top-level row of its own", () => {
    expect(hrefs.filter((h) => /schedule/i.test(h))).toEqual([]);
    expect(labels.filter((l) => /schedule/i.test(l))).toEqual([]);
  });

  // The ambiguity this IA fix removed: a single item cannot mean both "financial reporting" and
  // "all reporting". Finance never carries the word Reports on its own.
  // Admitting the finance right to the hub must not quietly demote the Finance page: a finance-only
  // user still lands on Finance, because that section is ranked ahead of the hub.
  it("still lands a finance-only user on Finance rather than the hub", () => {
    const finance = DASHBOARD_SECTIONS.findIndex((s) => s.path === "/dashboard/finance");
    const hub = DASHBOARD_SECTIONS.findIndex((s) => s.path === "/dashboard/reports");
    expect(finance).toBeGreaterThanOrEqual(0);
    expect(finance).toBeLessThan(hub);
  });

  it("never labels the Finance page 'Reports'", () => {
    const finance = NAV.find((n) => n.href === "/dashboard/finance");
    expect(finance!.label).not.toMatch(/report/i);
  });

  // Three separate top-level entries (Reports, Reports & Audit, Audit Log) was the outcome the brief
  // explicitly ruled out; two entries pointing into one hub is the same mistake wearing a hat.
  it("has no duplicate hrefs and no duplicate labels", () => {
    expect(new Set(hrefs).size).toBe(hrefs.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("does not keep a separate top-level Audit Log row beside the hub that contains it", () => {
    expect(hrefs).not.toContain("/dashboard/audit");
    expect(labels.filter((l) => /^audit/i.test(l))).toEqual([]);
  });

  // /dashboard/audit is NOT dead — it keeps its route, its permission and its deep links (the
  // warehouse detail's audit tab and the dashboard worklist both reach it). It simply stopped being
  // a sidebar row, because the hub now contains it.
  it("keeps audit.view claimed by exactly one nav entry — the hub", () => {
    expect(NAV.filter((n) => n.perms.includes("audit.view")).map((n) => n.href)).toEqual(["/dashboard/reports"]);
  });

  it("keeps the old finance redirect gone — /dashboard/reports is the hub, not Finance", () => {
    const hub = NAV.find((n) => n.href === "/dashboard/reports");
    expect(hub!.label).not.toMatch(/finance/i);
  });
});

// ── A warehouse-scoped user keeps the reporting tabs ──────────────────────────────────────────
//
// The hub row inherited `hideForWarehouseScoped` from the Audit Log row it replaced. That flag hides
// the WHOLE row (lib/nav.ts), which was right when the row WAS the system-wide audit page — and
// wrong once it became a hub of three surfaces: it took Custom Reports and Scheduled Reports away
// from every warehouse-scoped user, including one explicitly granted `reports.view`.
//
// Moving it to the TAB was still the wrong layer, and it produced the mirror-image bug. The seeded
// `warehouse_manager` holds `audit.view` and NOT `reports.view`: the row appeared, the page gate let
// them in, their one tab was then removed for being warehouse-scoped, and the empty-tab fallback
// mounted Custom Reports — which 403s. Hiding a tab is an authorization decision, and warehouse scope
// is not a permission.
//
// The rule is now permissions only (reportsTabs.ts), and the restriction it was standing in for is
// enforced where it always actually was: audit.service derives `scopeWarehouseIds` from the actor on
// every read, so a scoped user opening the tab sees their own warehouses and nothing else.
describe("warehouse-scoped users reach reports and their own audit trail", () => {
  it("does not hide the whole hub from them", () => {
    const hub = NAV.find((n) => n.href === "/dashboard/reports");
    expect(
      hub!.hideForWarehouseScoped,
      "hiding the row takes Custom Reports and Scheduled Reports with it — gate on permissions instead",
    ).toBeFalsy();
  });

  it("decides tabs on permissions alone, never on warehouse-scoped status", () => {
    const hub = readFileSync(
      join(process.cwd(), "src", "components", "dashboard", "reports", "ReportsAuditHub.tsx"),
      "utf8",
    );
    const code = hub.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    expect(
      code,
      "warehouse scope is not a permission — it must not gate a tab. Audit data is scoped in audit.service.",
    ).not.toMatch(/isWarehouseScoped/);
    // The visibility rule lives in the DOM-free module the suite can execute; see reportsTabs.test.ts.
    expect(code).toContain("visibleReportTabs");
  });

  it("never falls back to a tab the user does not hold", () => {
    const hub = readFileSync(
      join(process.cwd(), "src", "components", "dashboard", "reports", "ReportsAuditHub.tsx"),
      "utf8",
    );
    const code = hub.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    // `?? "custom"` was the fallback that turned "no tabs" into a guaranteed 403.
    expect(code, 'an empty tab set must render an explanation, never default to "custom"').not.toMatch(
      /\?\?\s*"custom"/,
    );
  });
});
