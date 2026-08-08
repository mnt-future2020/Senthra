import { describe, expect, it, vi } from "vitest";

// Integrity checks on the REAL catalog. The repositories are stubbed away so importing the registry
// stays cheap — no `run` function is ever called here; only the metadata is under test. These guard
// the failure mode nothing else can catch: a badge that silently never appears (typo'd key, key with
// no source, item that rolls up to a sidebar row that doesn't exist).
vi.mock("#modules/purchase-request/purchase-request.repository.js", () => ({}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({}));
vi.mock("#modules/job/job.repository.js", () => ({}));
vi.mock("#modules/job-kit-request/job-kit-request.repository.js", () => ({}));
vi.mock("#modules/van-stock-request/van-stock-request.repository.js", () => ({}));
vi.mock("#modules/goods-in/goods-in.repository.js", () => ({}));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({}));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({}));
vi.mock("#modules/customer/customer.repository.js", () => ({}));
vi.mock("#modules/inventory/inventory.repository.js", () => ({}));
vi.mock("#modules/inventory/inventory.service.js", () => ({}));

import {
  ATTENTION_ENTITY_SOURCES,
  ATTENTION_ITEMS,
  ATTENTION_NAV,
  ATTENTION_SOURCES,
} from "./attention.registry.js";
import { PERMISSION_GROUPS } from "#modules/role/permissions.js";

const NAV_HREFS = new Set<string>(Object.values(ATTENTION_NAV));
const ALL_PERMISSION_KEYS = new Set(PERMISSION_GROUPS.flatMap((g) => g.permissions.map((p) => p.key)));

describe("attention catalog integrity", () => {
  it("has no duplicate item keys", () => {
    const keys = ATTENTION_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every item is produced by exactly one source", () => {
    const produced = ATTENTION_SOURCES.flatMap((s) => s.keys);
    expect(new Set(produced).size).toBe(produced.length); // no key claimed twice
    for (const item of ATTENTION_ITEMS) {
      expect(produced, `"${item.key}" has no source — its badge could never appear`).toContain(item.key);
    }
  });

  it("every source key corresponds to a real item", () => {
    const items = new Set(ATTENTION_ITEMS.map((i) => i.key));
    for (const s of ATTENTION_SOURCES) {
      for (const k of s.keys) {
        expect(items, `source "${s.id}" produces "${k}", which no item declares`).toContain(k);
      }
    }
  });

  it("every permission referenced is a REAL permission key", () => {
    // A typo here is invisible at runtime — the badge simply never shows for anyone.
    for (const item of ATTENTION_ITEMS) {
      expect(item.perms.length, `"${item.key}" has no permission gate`).toBeGreaterThan(0);
      for (const p of item.perms) {
        expect(ALL_PERMISSION_KEYS, `"${item.key}" references unknown permission "${p}"`).toContain(p);
      }
    }
  });

  it("every item rolls up to a known sidebar row and is labelled", () => {
    for (const item of ATTENTION_ITEMS) {
      expect(NAV_HREFS, `"${item.key}" points at an unknown nav row`).toContain(item.nav);
      expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });

  // THE regression guard for this catalog's worst bug. Ten of twenty-six items used to carry the bare
  // module list as their href — `/dashboard/warehouses`, `/dashboard/jobs`, `/dashboard/customers` —
  // because the count is an aggregate with no screen behind it. Rendered as a link and clicked, that
  // navigated without narrowing anything, and on the module's OWN page it reloaded the page the user
  // was already standing on. Seven of the ten were rendered on exactly that page.
  //
  // So: an href must FILTER. A count that can't name a filtered destination gets no href at all and
  // renders as a number (see the allow-list below), which is honest and cannot mislead.
  it("never links to a bare module list — an href must narrow the screen it opens", () => {
    for (const item of ATTENTION_ITEMS) {
      if (!item.href) continue;
      expect(item.href.startsWith("/dashboard/"), `"${item.key}" href must be an app route`).toBe(true);
      expect(
        item.href.includes("?"),
        `"${item.key}" links to the bare list ${item.href} — clicking it would navigate without showing its ${item.label.toLowerCase()}`,
      ).toBe(true);
    }
  });

  // Two queues that count DIFFERENT things cannot open the SAME screen — one of them is then lying by
  // construction. "Deliveries to receive" (sent + supplier_accepted + partially_received) and
  // "Awaiting supplier acceptance" (sent) both pointed at `?status=sent`: the first chip read 14 and
  // opened a list of 7, which is the second chip's list.
  it("gives every queue its own destination", () => {
    const linked = ATTENTION_ITEMS.filter((i) => i.href);
    const byHref = new Map<string, string[]>();
    for (const i of linked) byHref.set(i.href!, [...(byHref.get(i.href!) ?? []), i.key]);
    for (const [href, keys] of byHref) {
      expect(keys.length, `${keys.join(" and ")} both open ${href} — they count different rows`).toBe(1);
    }
  });

  // Deliberate, reviewed decisions — each one is a queue worked on a single entity's own page, with no
  // cross-entity screen to open. Listing them here means ADDING a link-less count is a conscious edit
  // rather than a forgotten href, and that building the missing screen later shows up as a test change.
  const NO_DESTINATION = new Set([
    "jobs.kit_requests", // reviewed inside a job (JobDetail → JobKitRequestsReview)
    "wh.to_issue", "wh.awaiting_return", "wh.overdue_holdings", // warehouse detail → Goods Management
    "wh.van_requests", "wh.van_returns", // warehouse detail → Field Stock Requests
    "wh.customer_intake", "wh.stock_entry_drafts", // warehouse detail → Incoming / Inventory, customer pool
    "cust.stock_requests", "cust.awaiting_assignment", // customer detail → Submissions tab
    "cust.portal_invites", // customer detail → portal users
  ]);

  it("only the reviewed aggregates go without a destination", () => {
    for (const item of ATTENTION_ITEMS) {
      if (item.href) {
        expect(NO_DESTINATION, `"${item.key}" now has an href — drop it from NO_DESTINATION`).not.toContain(item.key);
      } else {
        expect(
          NO_DESTINATION,
          `"${item.key}" has no href. If that is right, add it to NO_DESTINATION with the reason; if not, give it a filtered href`,
        ).toContain(item.key);
      }
    }
  });

  // The tabs WarehouseDetail accepts (its TABS table). A warehouseQuery naming anything else opens the
  // fallback tab — the user lands on the warehouse but not on the work, which is the same class of
  // near-miss as the bare-list hrefs above.
  const WAREHOUSE_TABS = ["overview", "incoming", "inventory", "goods", "van", "demand", "transactions", "audit"];
  const WAREHOUSE_TAB_PARAMS = ["tab", "pool", "inbound"];

  it("warehouseQuery names a real warehouse tab, and only warehouse rows use it", () => {
    for (const item of ATTENTION_ITEMS) {
      if (!item.warehouseQuery) continue;
      expect(item.nav, `"${item.key}" has a warehouseQuery but doesn't roll up to Warehouses`).toBe(ATTENTION_NAV.warehouses);
      expect(item.href, `"${item.key}" has both an href and a warehouseQuery — one destination only`).toBeUndefined();
      const params = new URLSearchParams(item.warehouseQuery);
      expect(WAREHOUSE_TABS, `"${item.key}" opens unknown tab "${params.get("tab")}"`).toContain(params.get("tab"));
      for (const p of params.keys()) {
        expect(WAREHOUSE_TAB_PARAMS, `"${item.key}" passes ?${p}=, which the warehouse page ignores`).toContain(p);
      }
    }
  });

  // The filter values every href promises, and the screen that must honour each one. A count is only
  // half an answer: clicking "Deliveries overdue · 4" has to open those 4 rows, not all 30 sent POs.
  // Both entries below were WRONG on first write (`?due=overdue`, `?status=sent`) and shipped a red
  // badge onto an unfiltered list — hence this table.
  const SUPPORTED_FILTERS: Record<string, string[]> = {
    "/dashboard/purchase-requests": ["status"],
    "/dashboard/purchase-orders": ["status", "awaiting"],
    "/dashboard/jobs": ["status", "customer", "engineer", "q"],
    "/dashboard/goods-in": ["status"],
    "/dashboard/inventory": ["status", "tab", "critical"],
    "/dashboard/customers": ["tab"],
  };

  // The catalog's own vocabulary, so a typo'd pseudo-status ("receivable" → "receivables") can't ship
  // as a filter the server drops on the floor, opening an unfiltered list under an urgent badge.
  const SUPPORTED_VALUES: Record<string, string[]> = {
    "/dashboard/purchase-orders?status": [
      "awaiting_approval", "awaiting_send", "receivable", "overdue", // derived — buildWhere resolves each
      "draft", "pending_approval", "approved", "pm_review", "sent",
      "supplier_accepted", "partially_received", "fully_received", "closed", "cancelled",
    ],
    "/dashboard/jobs?status": ["overdue", "draft", "assigned", "accepted", "in_progress", "completed", "cancelled", "rejected"],
    // `rework` is derived — buildWhere resolves it from reworkPrfWhere, the predicate the badge counts.
    "/dashboard/purchase-requests?status": ["rework", "draft", "submitted", "approved", "converted", "cancelled"],
    "/dashboard/goods-in?status": ["draft", "completed", "cancelled"],
    "/dashboard/inventory?tab": ["all", "company", "customer", "engineer", "damaged", "movements", "reorder"],
  };

  it("passes filter VALUES the destination screen knows", () => {
    for (const item of ATTENTION_ITEMS) {
      if (!item.href) continue;
      const [path, query] = item.href.split("?");
      for (const [param, value] of new URLSearchParams(query ?? "")) {
        const allowed = SUPPORTED_VALUES[`${path}?${param}`];
        if (!allowed) continue; // only the enum-valued params are pinned here
        expect(allowed, `"${item.key}" passes ?${param}=${value}, which ${path} does not resolve`).toContain(value);
      }
    }
  });

  it("only deep-links through filters the destination screen actually reads", () => {
    for (const item of ATTENTION_ITEMS) {
      if (!item.href) continue;
      const [path, query] = item.href.split("?");
      const supported = SUPPORTED_FILTERS[path];
      expect(supported, `"${item.key}" links to ${path}, which isn't a known list screen`).toBeDefined();
      for (const pair of query ? query.split("&") : []) {
        const param = pair.split("=")[0];
        expect(supported, `"${item.key}" passes ?${param}=, which ${path} ignores — the badge would open an UNFILTERED list`).toContain(param);
      }
    }
  });

  // The rollup is a plain sum, which is only correct while the keys are disjoint. `subsetOf` is the
  // single declared exception; anything claiming it must name a real sibling on the same nav row, or
  // the badge silently drops a count that had nowhere to be absorbed into.
  it("a subset names a real parent on the same sidebar row, and parents are not themselves subsets", () => {
    const byKey = new Map(ATTENTION_ITEMS.map((i) => [i.key, i]));
    for (const item of ATTENTION_ITEMS) {
      if (!item.subsetOf) continue;
      const parent = byKey.get(item.subsetOf);
      expect(parent, `"${item.key}" is a subset of "${item.subsetOf}", which no item declares`).toBeDefined();
      expect(parent!.nav, `"${item.key}" and its parent badge different rows`).toBe(item.nav);
      // One level only: a chain would need the rollup to resolve transitively, which it does not do.
      expect(parent!.subsetOf, `"${item.subsetOf}" is itself a subset — chains are not supported`).toBeUndefined();
      expect(item.key).not.toBe(item.subsetOf);
    }
  });

  // A subset is only counted correctly if its parent is visible to the same people; otherwise an actor
  // holding just the child's permission sees a chip whose count never reaches the badge.
  it("a subset is gated by the same permissions as its parent", () => {
    const byKey = new Map(ATTENTION_ITEMS.map((i) => [i.key, i]));
    for (const item of ATTENTION_ITEMS) {
      if (!item.subsetOf) continue;
      expect([...item.perms].sort(), `"${item.key}" can be visible when "${item.subsetOf}" is not`).toEqual(
        [...byKey.get(item.subsetOf)!.perms].sort(),
      );
    }
  });

  it("keeps red for genuine emergencies — critical stays a small minority", () => {
    const critical = ATTENTION_ITEMS.filter((i) => i.tone === "critical");
    // Overuse of red is how badge systems stop being read. Overdue/blocked only.
    expect(critical.length).toBeLessThanOrEqual(6);
    expect(critical.length).toBeGreaterThan(0);
  });

  it("does not badge master-data modules", () => {
    // Suppliers / IRM / Settings / Users / Audit have no workflow — a badge there is noise by design.
    const banned = ["/dashboard/suppliers", "/dashboard/irm", "/dashboard/settings", "/dashboard/users", "/dashboard/audit"];
    for (const item of ATTENTION_ITEMS) expect(banned).not.toContain(item.nav);
  });
});

// The per-row counts are the ONLY navigation the link-less aggregates have. A key that lost its href
// and never reached an entity source would be a number the user can see and can't get to from
// anywhere — strictly worse than the bare-list link it replaced.
describe("attention entity catalog integrity", () => {
  const ITEM = new Map(ATTENTION_ITEMS.map((i) => [i.key, i]));

  it("every entity source key is a real item", () => {
    for (const s of ATTENTION_ENTITY_SOURCES) {
      for (const k of s.keys) {
        expect([...ITEM.keys()], `entity source "${s.id}" splits "${k}", which no item declares`).toContain(k);
      }
    }
  });

  it("no key is split twice within one dimension", () => {
    for (const dimension of ["warehouse", "customer"] as const) {
      const produced = ATTENTION_ENTITY_SOURCES.filter((s) => s.dimension === dimension).flatMap((s) => s.keys);
      expect(new Set(produced).size, `a ${dimension} key is claimed by two sources — its row count would double`).toBe(produced.length);
    }
  });

  it("a key's dimension matches the nav row it belongs to", () => {
    const NAV_FOR: Record<string, string> = {
      warehouse: ATTENTION_NAV.warehouses,
      customer: ATTENTION_NAV.customers,
    };
    for (const s of ATTENTION_ENTITY_SOURCES) {
      for (const k of s.keys) {
        expect(ITEM.get(k)?.nav, `"${k}" is split by ${s.dimension} but rolls up elsewhere`).toBe(NAV_FOR[s.dimension]);
      }
    }
  });

  // Two exemptions, both argued in the ATTENTION_ENTITY_SOURCES header: the overdue read has no
  // warehouse-grouped form and overlaps the two queues either side of it, and grn_drafts/goods_in have
  // real cross-warehouse screens. Anything else without a row count is unreachable.
  it("every link-less count is reachable from some row", () => {
    const split = new Set(ATTENTION_ENTITY_SOURCES.flatMap((s) => s.keys));
    const exempt = new Set([
      "wh.overdue_holdings", // no groupable form; shown on the warehouse's own Goods tab
      "jobs.kit_requests", // the jobs LIST already carries a per-row pending-kit-request count
    ]);
    // `warehouseQuery` does NOT count as reachability: the service only upgrades it to a link for an
    // actor scoped to one warehouse, so a manager over several still needs the row.
    for (const item of ATTENTION_ITEMS) {
      if (item.href || exempt.has(item.key)) continue;
      expect(split, `"${item.key}" has no href and no per-row count — nothing can reach it`).toContain(item.key);
    }
  });
});
