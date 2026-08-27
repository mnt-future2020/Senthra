// ── Which tabs the Reports & Audit hub offers, as a pure decision ──────────────────────────────
//
// Extracted from ReportsAuditHub for the reason this codebase already extracts rentalRowActions and
// multiSelectKeys: the frontend suite runs in Node with no renderer, so a rule living inside a
// component is a rule nothing can assert. This particular rule had already gone wrong once in a way
// only a human clicking the nav row would have found.
//
// THE RULE IS PERMISSIONS, AND NOTHING ELSE.
//
// The hub previously also dropped the Audit Trail tab for a warehouse-scoped user — an authorization
// decision taken from something that is not a permission, and one that disagreed with the nav row
// above it. The seeded `warehouse_manager` holds `audit.view` and not `reports.view`: the row showed,
// the page gate admitted them, their one tab was then removed, and the empty-tab fallback mounted
// Custom Reports, which 403s. Warehouse scoping of audit DATA is enforced in audit.service, which
// derives `scopeWarehouseIds` from the actor on every read — hiding the tab never made that true.

export type ReportTabId = "custom" | "scheduled" | "audit";

export interface ReportTabDef {
  id: ReportTabId;
  label: string;
  /** ANY-OF, matching the nav rail's own rule and the page gate's `anyOf`. */
  perms: string[];
}

export const REPORT_TABS: readonly ReportTabDef[] = [
  { id: "custom", label: "Custom Reports", perms: ["reports.view"] },
  // Scheduling sits beside Custom Reports because it automates them — and the Finance report, which
  // is why the finance right opens this tab too. Which reports a user may actually schedule is
  // decided per report, server-side: the form only offers what the save would accept.
  { id: "scheduled", label: "Scheduled Reports", perms: ["reports.view", "reports.finance.view"] },
  { id: "audit", label: "Audit Trail", perms: ["audit.view"] },
];

/**
 * The union of every permission that opens SOME tab.
 *
 * The nav row and the page gate must admit exactly this set — one more and a user reaches a hub with
 * nothing in it, one fewer and a user is locked out of a tab they hold. `reportsTabs.test.ts` pins
 * all three against each other so they cannot drift apart again.
 */
export const REPORT_HUB_PERMISSIONS: string[] = [...new Set(REPORT_TABS.flatMap((t) => t.perms))];

/** The tabs this user may open. */
export function visibleReportTabs(can: (perm: string) => boolean): ReportTabDef[] {
  return REPORT_TABS.filter((t) => t.perms.some((p) => can(p)));
}

/**
 * Which tab to show, given what the URL asked for.
 *
 * `null` when the user holds none — the caller must render an explanation rather than fall back to a
 * surface the server will refuse. A requested tab the user cannot open is not an error: it clamps to
 * their first real tab, so a shared `?tab=audit` link still works for a colleague without `audit.view`.
 */
export function activeReportTab(visible: ReportTabDef[], requested: string | null): ReportTabId | null {
  if (visible.some((t) => t.id === requested)) return requested as ReportTabId;
  return visible[0]?.id ?? null;
}
