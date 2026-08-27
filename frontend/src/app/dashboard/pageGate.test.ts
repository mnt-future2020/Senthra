import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NAV } from "@/components/dashboard/shell/Sidebar";

// ── The THIRD table describing "which permission opens which page" ────────────────────────────
//
// Sidebar.nav.test.ts already pins NAV against DASHBOARD_SECTIONS. It cannot see the one that
// actually decides whether a page renders: the `<PermissionGate anyOf={…}>` written into the route
// file itself. That third list drifted, and the failure was invisible to every existing test —
// nav, landing list and hub tabs all admitted `reports.finance.view`, the page did not, and the
// seeded Finance Director (finance.view + export, deliberately no `reports.view`) got a nav row
// leading to "You don't have access to this page".
//
// A nav row is a PROMISE. Any permission that puts the row on screen has to get past the door.
//
// Read from source rather than rendered: the gate is a server component's JSX, and what matters is
// the literal list a developer edits — that is where the drift happens.

const APP = join(process.cwd(), "src", "app");

/**
 * The `anyOf` list a route file's PermissionGate declares, or null if it has no gate.
 *
 * Comments are stripped BEFORE the permission strings are read. These gates are heavily commented —
 * that is the house style and the reason the lists are legible — and an apostrophe in prose ("its own
 * module's tabs") reads as a quote delimiter to a naive string matcher, which silently returns a
 * fragment of the comment as if it were the permission list.
 */
function gateOf(route: string): string[] | null {
  const src = readFileSync(join(APP, route.replace(/^\//, ""), "page.tsx"), "utf8");
  // `[\s\S]` rather than the `s` flag: this project's tsconfig target predates dotAll.
  const m = src.match(/<PermissionGate[\s\S]*?anyOf=\{\[([^\]]*)\]\}/);
  if (!m) return null;
  const code = m[1]!
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .join("\n");
  return [...code.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!).sort();
}

describe("a nav row never leads to a page that refuses it", () => {
  // Only the rows whose route file carries a gate. A page may legitimately have none (it guards
  // itself another way, e.g. CustomerGuard on the portal) — that is not drift.
  const gated = NAV.map((n) => ({ nav: n, gate: gateOf(n.href) })).filter(
    (x): x is { nav: (typeof NAV)[number]; gate: string[] } => x.gate !== null,
  );

  it("finds gated routes to check", () => {
    expect(gated.length).toBeGreaterThan(0);
  });

  it.each(gated.map((g) => [g.nav.href, g.nav.label] as const))(
    "%s (%s) admits every permission its nav row does",
    (href) => {
      const { nav, gate } = gated.find((g) => g.nav.href === href)!;
      const missing = nav.perms.filter((p) => !gate.includes(p));
      expect(
        missing,
        `${href} shows in the sidebar for [${missing.join(", ")}] but its PermissionGate does not admit ` +
          `them — those users get a dead link. Add them to the gate, or take them off the nav row.`,
      ).toEqual([]);
    },
  );

  // The specific regression, named so it reads as the requirement it is rather than a generic case.
  it("lets a finance-only role reach the hub that holds Scheduled Reports", () => {
    expect(gateOf("/dashboard/reports")).toContain("reports.finance.view");
  });

  // The mirror: Finance stays finance-only. `reports.view` gates the general hub and must not open
  // a page of spend figures.
  it("keeps Finance gated on the finance right alone", () => {
    expect(gateOf("/dashboard/finance")).toEqual(["reports.finance.view"]);
  });
});
