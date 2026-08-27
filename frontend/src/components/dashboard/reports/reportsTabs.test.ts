import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NAV } from "@/components/dashboard/shell/Sidebar";
import { DASHBOARD_SECTIONS } from "@/lib/auth";
import { activeReportTab, REPORT_HUB_PERMISSIONS, visibleReportTabs } from "./reportsTabs";

// ── nav row → page gate → hub tab, pinned as ONE chain ─────────────────────────────────────────
//
// Three separate lists decide whether a user gets from the sidebar to something they can actually
// read, and each one was edited on its own:
//
//   1. Sidebar.NAV                          — does the row appear?
//   2. <PermissionGate anyOf> in page.tsx   — does the page render?
//   3. REPORT_TABS                          — is there a tab to show?
//
// Sidebar.nav.test.ts pins (1) against DASHBOARD_SECTIONS and pageGate.test.ts pins (1) against (2).
// Nothing pinned (3), and that is where it broke: the hub dropped the Audit Trail tab for a
// warehouse-scoped user, so the seeded `warehouse_manager` — `audit.view`, no `reports.view` — passed
// (1) and (2) and arrived at a hub with no tabs, which fell back to mounting Custom Reports and 403'd.
//
// A row that appears must lead to a tab that opens. That is the invariant this file exists to hold.

const HUB = "/dashboard/reports";
const can = (perms: string[]) => (p: string) => perms.includes(p);

/** Same reader pageGate.test.ts uses — the literal `anyOf` list a developer edits, comments stripped. */
function gateOf(route: string): string[] {
  const src = readFileSync(join(process.cwd(), "src", "app", route.replace(/^\//, ""), "page.tsx"), "utf8");
  const m = src.match(/<PermissionGate[\s\S]*?anyOf=\{\[([^\]]*)\]\}/);
  const code = (m?.[1] ?? "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  return [...code.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!).sort();
}

describe("the hub shows exactly the tabs a user's permissions open", () => {
  it("an audit-only user sees Audit Trail and nothing else", () => {
    const visible = visibleReportTabs(can(["audit.view"]));
    expect(visible.map((t) => t.id)).toEqual(["audit"]);
  });

  it("a reports-only user sees Custom Reports and Scheduled Reports, not the Audit Trail", () => {
    const visible = visibleReportTabs(can(["reports.view"]));
    expect(visible.map((t) => t.id)).toEqual(["custom", "scheduled"]);
  });

  it("a user with both sees both", () => {
    const visible = visibleReportTabs(can(["reports.view", "audit.view"]));
    expect(visible.map((t) => t.id)).toEqual(["custom", "scheduled", "audit"]);
  });

  it("a finance-only user reaches Scheduled Reports and no other tab", () => {
    // The seeded Finance Director: `reports.finance.view` + `reports.export`, deliberately NOT
    // `reports.view`. Scheduling the Finance report is the whole reason this door admits them.
    const visible = visibleReportTabs(can(["reports.finance.view", "reports.export"]));
    expect(visible.map((t) => t.id)).toEqual(["scheduled"]);
  });

  it("a user with none of the rights gets no tab at all — never a fallback to one they lack", () => {
    const visible = visibleReportTabs(can(["inventory.view"]));
    expect(visible).toEqual([]);
    // THE regression, in one line: this used to resolve to "custom", which then 403'd.
    expect(activeReportTab(visible, null)).toBeNull();
  });
});

describe("a warehouse-scoped audit user is not stranded", () => {
  // Warehouse scoping is not a permission and must not decide a tab. The audit DATA is scoped in
  // audit.service (`scopeWarehouseIds` derived from the actor on list, facets and export alike), so
  // showing the tab restricts nothing that was previously restricted.
  const WAREHOUSE_MANAGER = ["audit.view", "inventory.view", "warehouses.view"];

  it("sees the Audit Trail tab", () => {
    expect(visibleReportTabs(can(WAREHOUSE_MANAGER)).map((t) => t.id)).toEqual(["audit"]);
  });

  it("lands on Audit Trail rather than an empty hub", () => {
    const visible = visibleReportTabs(can(WAREHOUSE_MANAGER));
    expect(activeReportTab(visible, null)).toBe("audit");
  });

  it("is never resolved onto Custom Reports, which would 403", () => {
    const visible = visibleReportTabs(can(WAREHOUSE_MANAGER));
    // Including from a shared deep link naming a tab they do not hold.
    expect(activeReportTab(visible, "custom")).toBe("audit");
    expect(activeReportTab(visible, "scheduled")).toBe("audit");
  });
});

describe("a requested tab is honoured when held, clamped when not", () => {
  it("honours ?tab= for a tab the user holds", () => {
    const visible = visibleReportTabs(can(["reports.view", "audit.view"]));
    expect(activeReportTab(visible, "audit")).toBe("audit");
  });

  it("clamps an unknown or unheld ?tab= to the user's first real tab", () => {
    const visible = visibleReportTabs(can(["reports.view"]));
    expect(activeReportTab(visible, "audit")).toBe("custom");
    expect(activeReportTab(visible, "nonsense")).toBe("custom");
  });
});

describe("nav row → page gate → hub tab agree", () => {
  const navRow = NAV.find((n) => n.href === HUB);

  it("the hub has a nav row", () => {
    expect(navRow).toBeDefined();
  });

  it("every permission that shows the nav row opens at least one tab", () => {
    // Otherwise the row is a promise the hub cannot keep — which is exactly what shipped.
    const stranded = navRow!.perms.filter((p) => visibleReportTabs(can([p])).length === 0);
    expect(
      stranded,
      `[${stranded.join(", ")}] put the "Reports & Audit" row in the sidebar but open no tab. ` +
        `Either give the permission a tab in REPORT_TABS, or take it off the nav row.`,
    ).toEqual([]);
  });

  it("every permission that opens a tab is on the nav row, so the tab is reachable", () => {
    const unreachable = REPORT_HUB_PERMISSIONS.filter((p) => !navRow!.perms.includes(p));
    expect(
      unreachable,
      `[${unreachable.join(", ")}] open a hub tab but do not show the nav row — the tab exists and ` +
        `nobody can navigate to it.`,
    ).toEqual([]);
  });

  it("the page gate admits exactly the permissions the tabs need", () => {
    expect(gateOf(HUB).sort()).toEqual([...REPORT_HUB_PERMISSIONS].sort());
  });

  it("the landing-section list matches the nav row", () => {
    // A user whose ONLY section is this one is sent here by firstDashboardPath; if that list is wider
    // than the nav row, they land on a page the sidebar never offered them.
    const section = DASHBOARD_SECTIONS.find((s) => s.path === HUB);
    expect(section).toBeDefined();
    expect([...section!.anyOf].sort()).toEqual([...navRow!.perms].sort());
  });

  it("the hub row carries no warehouse-scoped exclusion", () => {
    // `hideForWarehouseScoped` hides the whole row. On a hub of three surfaces that would take Custom
    // Reports and Scheduled Reports away to hide the Audit Trail — the inverse of the bug above, and
    // the reason the flag was removed. Audit data stays scoped in audit.service either way.
    expect(navRow!.hideForWarehouseScoped ?? false).toBe(false);
  });
});
