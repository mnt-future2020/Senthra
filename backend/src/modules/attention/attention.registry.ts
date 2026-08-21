// ── THE ATTENTION CATALOG — the single source of truth for "what needs a human" ────────────────
//
// Every badge, dashboard strip chip and module tab count in the product resolves to an entry here.
// Adding a count later = ONE entry (+ its source) and nothing else changes.
//
// Two halves:
//   ITEMS   — pure metadata: key, label, the permissions that may SEE it, urgency tone, which sidebar
//             row it rolls up to (`nav`) and where clicking it should land (`href`).
//   SOURCES — the queries. One source may produce several keys (one round trip, several counts). A
//             source only runs when the actor can see at least one of its keys, and the service emits
//             only the keys the actor's own permissions allow — so a source can never leak a count.
//
// RULES OF ENTRY (kept deliberately strict — a badge nobody can act on is noise):
//   1. A key must represent work a HUMAN still owes. Not a total, not a state, not a KPI.
//   2. Terminal states (closed / cancelled / reconciled / completed) never appear.
//   3. "Waiting on someone else" is not work FOR ME (a requester waiting on a reviewer gets nothing).
//   4. Tone: critical = overdue or blocked; attention = action awaited; info = actionable but calm.
//      Red is reserved — five keys only. Overusing it is how badge systems die.
//
// STATES THAT LOOK LIKE WORK BUT ARE NOT (verified in code — do not "add" these later):
//   • JobStockMovement.status "draft"  — the schema default is NEVER written; every create posts
//     directly, so the count is permanently 0.
//   • StockTransfer.status             — has exactly one value, "completed". Transfers are atomic.
//   • Reorder rows with covered:true   — already netted off by incoming POs / open PRFs.
//   • goodsStatus "issued"             — stock is legitimately out with an engineer; only OVERDUE is
//                                        work, and getOverdueSummary already owns that.
//   • User.mustResetPassword           — true for every freshly created staff user and cleared by the
//                                        USER, not the admin. It is the user's action, not ours.
//   • User.status inactive/suspended   — deliberate admin decisions, i.e. states, not a backlog.
//   • EmailLog.status "failed"         — ops diagnostics, not a work queue.
//   • Delete-guard counters (countOpenByWarehouse, sumNotReceivedUnitsByCustomer, …) — not
//     actor-scoped; showing them would give a manager numbers they cannot act on.
//   • Job.status "draft"               — the schema default is NEVER written: the single create path
//                                        posts "assigned" (a job is raised WITH an engineer on it) and
//                                        no transition writes it back. There was a "Drafts to assign"
//                                        key here reading exactly this count; it was permanently 0 and
//                                        its `?status=draft` deep link opened a permanently empty list.
//                                        If a save-as-draft flow is ever built, the key comes back with
//                                        it — not before. `jobs.awaiting_acceptance` is the real
//                                        "nobody has picked this up yet" queue.
//   • Master data (Suppliers, IRM catalogue, all *-types, Settings, Audit Log) — no workflow at all.
//
// RENTAL — every key counts LINES on a PURCHASE ORDER, because the PO is the committed hire; a
// purchase request that never converted hired nothing, so it raises no deadline.
//
// A hire is worked by TWO different people and therefore needs two kinds of key, which the first
// pass missed. The `rentals.*` keys are the PM's: company-wide, rolled up to Inventory, asking "is
// this hire running away from us?" (ending soon, overdue, should-already-be-here). `wh.rental_intake`
// is the WAREHOUSE's: scoped to the actor's own doors, rolled up to Warehouses, asking "is there kit
// to receive?" — and it is the one that was missing. Its absence meant a hire could sit in a
// warehouse's Rental deliveries pane with a Receive button on it and raise no count anywhere: not on
// the pane's pill, not on the Incoming stock tab, not on the Warehouses list row, not on the sidebar.
// The only rental key that touched it, `rentals.awaiting_delivery`, is bounded by the hire START
// date, so it stayed silent until the hire was ALREADY LATE, and then linked to Inventory rather
// than to the warehouse holding the Receive button.
//
// The two overlap on purpose and neither is a subset of the other: they have different scopes,
// different owners and different sidebar rows. Collapsing them would silence one of the two jobs.

import * as prfRepo from "#modules/purchase-request/purchase-request.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import * as kitRepo from "#modules/job-kit-request/job-kit-request.repository.js";
import * as vsrRepo from "#modules/van-stock-request/van-stock-request.repository.js";
import * as grnRepo from "#modules/goods-in/goods-in.repository.js";
import * as gmRepo from "#modules/goods-management/goods-management.repository.js";
import * as gmService from "#modules/goods-management/goods-management.service.js";
import * as customerRepo from "#modules/customer/customer.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";

export type AttentionTone = "info" | "attention" | "critical";

// Sidebar rows that can carry a badge. Master-data rows are absent on purpose.
export const ATTENTION_NAV = {
  purchaseRequests: "/dashboard/purchase-requests",
  purchaseOrders: "/dashboard/purchase-orders",
  jobs: "/dashboard/jobs",
  warehouses: "/dashboard/warehouses",
  inventory: "/dashboard/inventory",
  customers: "/dashboard/customers",
} as const;
export type AttentionNav = (typeof ATTENTION_NAV)[keyof typeof ATTENTION_NAV];

export interface AttentionItemMeta {
  key: string;
  label: string;
  /** anyOf — the actor needs ONE of these to see the count. */
  perms: string[];
  tone: AttentionTone;
  /** the sidebar row this rolls up to */
  nav: AttentionNav;
  /**
   * Where clicking it lands — deep-linked and pre-filtered.
   *
   * OPTIONAL, and absent is a real answer, not an oversight. A count only earns an href when the
   * whole count opens on ONE screen. Several queues here are aggregates over MANY entities — "Job kit
   * to issue · 12" is 7 at WH-A and 5 at WH-B, and the work is done inside a warehouse, so there is no
   * single page that shows those 12 rows.
   *
   * The earlier version of this catalog gave those items the bare module list (`/dashboard/warehouses`)
   * as a stand-in. That reads as a link and behaves as one, but the destination does not contain the
   * work — and on the warehouses page itself it navigated to the page the user was already standing
   * on. A count with nowhere honest to go must render as a NUMBER, not a link; the fan-out is served
   * by the per-entity rollups instead (`byWarehouse` / `byCustomer` in attention.service), which put
   * each warehouse's or customer's own share on its own row, where clicking it means something.
   */
  href?: string;
  /**
   * anyOf — the permissions the DESTINATION page is gated on, when they differ from `perms`.
   *
   * `perms` says who may SEE this count; that is a permission to ACT on the queue and is routinely a
   * different grant from the one that opens the module. "Deliveries to receive" is gated on
   * `goods_in.create` but lands on Purchase Orders, which is behind `purchase_orders.view` — a
   * receiving clerk without the PO grant got a chip that looked and behaved like a link and delivered
   * them to a "You don't have access" screen. Every module-crossing item here had that shape, and so
   * did the same-module ones whose action grant does not imply the view grant (approve, convert,
   * submit, send, close, assign).
   *
   * When the actor lacks these, the service drops the `href` and the count renders as a plain number —
   * the behaviour the catalog already defines for a count with nowhere honest to go. The COUNT is not
   * hidden: the work is still theirs and knowing it exists is the point of the badge.
   */
  hrefPerms?: string[];
  /**
   * For warehouse-floor queues: the tab this work lives on inside a warehouse detail page.
   *
   * The service upgrades these to a real href — `/dashboard/warehouses/<code>?tab=<warehouseTab>` —
   * when the ACTOR can reach exactly one warehouse, which is the normal case for floor staff. A
   * multi-warehouse manager gets no href (the ambiguity is real) and uses the row counts instead.
   *
   * The value is the whole QUERY STRING (no leading `?`), not just the tab id, because two of these
   * queues live behind a tab's inner pool toggle and land on the wrong pane without it.
   * Tab ids are the ones WarehouseDetail accepts: overview | incoming | inventory | goods | van |
   * demand | transactions | audit.
   */
  warehouseQuery?: string;
  /**
   * This key's rows are a SUBSET of the named key's, so its count must not be added to the sidebar
   * badge a second time.
   *
   * Every other pair of keys in this catalog is disjoint, which is what lets the rollup be a plain
   * sum. "Critical stock" is the exception on purpose: it is the urgent slice of "Items to reorder"
   * (getReorderSummary's `criticalCount` is literally `count`'s rows filtered by `critical`), and it
   * earns its own chip because a red one-line warning is worth more than a footnote on an amber
   * number. Summing both would report N+1 items of work when there are N.
   *
   * The subset still contributes its TONE — a critical row must still turn the sidebar badge red.
   */
  subsetOf?: string;
}

/** Context handed to every source. `scope` undefined = unrestricted (admin / non-scoped role). */
export interface AttentionCtx {
  actor: AuditActor;
  scope?: string[];
  /** the acting user's id — for queues addressed to a specific person (PO pm_review) */
  userId?: string;
  now: Date;
  /** start of today in the COMPANY timezone — the one clock every "overdue" in the app shares */
  dayStart: Date;
  timeZone: string;
}

export interface AttentionSource {
  id: string;
  keys: string[];
  run: (ctx: AttentionCtx) => Promise<Record<string, number>>;
}

/** The entity a per-row count hangs off. One dimension per list screen that shows counts. */
export type AttentionDimension = "warehouse" | "customer";

/**
 * A source that splits its keys BY ENTITY — "7 at WH-A, 5 at WH-B" rather than "12".
 *
 * Deliberately a separate registry from ATTENTION_SOURCES rather than an extra field on it, because
 * these queries must NOT run on the ordinary badge path. That path fires once per page load for every
 * signed-in user; the two list screens that want per-row counts are a small fraction of navigations.
 * Splitting them keeps the sidebar's cost exactly where it was.
 *
 * `run` returns entityId → key → count. An entity with nothing outstanding is simply absent.
 */
export interface AttentionEntitySource {
  id: string;
  dimension: AttentionDimension;
  keys: string[];
  run: (ctx: AttentionCtx) => Promise<Record<string, Record<string, number>>>;
}

/** Fold `entityId → count` maps, one per key, into the entityId → key → count shape sources return. */
function byEntity(parts: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [key, counts] of Object.entries(parts)) {
    for (const [entityId, count] of Object.entries(counts)) {
      if (count > 0) (out[entityId] ??= {})[key] = count;
    }
  }
  return out;
}

// ── ITEMS ──────────────────────────────────────────────────────────────────────────────────────
export const ATTENTION_ITEMS: AttentionItemMeta[] = [
  // Purchase Requests
  { key: "prf.awaiting_approval", label: "PRFs to approve", perms: ["purchase_requests.approve"], tone: "attention", nav: ATTENTION_NAV.purchaseRequests, href: "/dashboard/purchase-requests?status=submitted", hrefPerms: ["purchase_requests.view"] },
  { key: "prf.awaiting_conversion", label: "Approved — generate PO", perms: ["purchase_requests.convert"], tone: "attention", nav: ATTENTION_NAV.purchaseRequests, href: "/dashboard/purchase-requests?status=approved", hrefPerms: ["purchase_requests.view"] },
  // ?status=rework is the DERIVED pseudo-status sharing reworkPrfWhere with this count — a draft that
  // was SENT BACK, not every draft. It pointed at `?status=draft` before, so a badge reading "3 need
  // rework" opened every draft in the module, including ones the reader had just started.
  { key: "prf.rework", label: "Rejected — needs rework", perms: ["purchase_requests.submit"], tone: "attention", nav: ATTENTION_NAV.purchaseRequests, href: "/dashboard/purchase-requests?status=rework", hrefPerms: ["purchase_requests.view"] },

  // Rentals — a hire is work a human still owes right up to the moment it goes back, and the
  // on-hire tab's filters share the very predicates these counts use, so each badge opens exactly
  // its own rows. They roll up to the INVENTORY row because rentals are reached through the
  // Inventory Hub (Inventory → Rentals), exactly like the IRM catalogue.
  { key: "rentals.expiring_soon", label: "Hires ending soon", perms: ["rentals.view"], tone: "attention", nav: ATTENTION_NAV.inventory, href: "/dashboard/inventory?tab=rental&rental=on-hire&status=expiring" },
  { key: "rentals.overdue", label: "Hires overdue for return", perms: ["rentals.view"], tone: "critical", nav: ATTENTION_NAV.inventory, href: "/dashboard/inventory?tab=rental&rental=on-hire&status=overdue" },
  // Every deadline above filters on `on_hire`, so a hire nobody has received raises NONE of them.
  // That is correct — kit that has not arrived cannot be overdue for return — but it means one
  // forgotten click could leave a hire billing with nothing chasing it. This badge asks about the
  // step itself, and only once the hire should already have started.
  //
  // `?status=late` is the DERIVED window sharing overdueDeliveryWhere with this count. It pointed at
  // `?status=awaiting` — the whole receiving queue — so the badge read one number and opened a longer
  // list, which is the same broken promise the registry records for `?status=sent` and `?status=draft`.
  { key: "rentals.awaiting_delivery", label: "Hires not yet received", perms: ["rentals.view"], tone: "attention", nav: ATTENTION_NAV.inventory, href: "/dashboard/inventory?tab=rental&rental=on-hire&status=late" },

  // Purchase Orders
  // ?status=awaiting_approval and ?status=awaiting_send are DERIVED pseudo-statuses sharing the exact
  // predicates these counts use (awaitingApprovalPoWhere / awaitingSendPoWhere) — each queue spans
  // more than one real status, so pointing at a single stored status would open FEWER rows than the
  // badge counted. awaiting_send is PM-scoped on both sides for an actor without assign_pm.
  { key: "po.awaiting_approval", label: "POs to approve", perms: ["purchase_orders.approve"], tone: "attention", nav: ATTENTION_NAV.purchaseOrders, href: "/dashboard/purchase-orders?status=awaiting_approval", hrefPerms: ["purchase_orders.view"] },
  { key: "po.awaiting_send", label: "Approved — send to supplier", perms: ["purchase_orders.send", "purchase_orders.assign_pm"], tone: "attention", nav: ATTENTION_NAV.purchaseOrders, href: "/dashboard/purchase-orders?status=awaiting_send", hrefPerms: ["purchase_orders.view"] },
  // Overlaps the two above on a `sent` order that also has goods to receive, and is deliberately NOT
  // marked a subset: it is neither nested in them (a hire-only order is `sent` with nothing to
  // receive, so it is here and not there) nor the same work — chasing an acknowledgement and booking
  // a delivery in are two follow-ups, often by two people holding different permissions. Narrowing
  // the COUNT to make the row arithmetic tidier would also have to narrow `?status=sent`, or the
  // badge would open more rows than it counted, which is the failure the notes above guard against.
  { key: "po.awaiting_acceptance", label: "Awaiting supplier acceptance", perms: ["purchase_orders.acknowledge"], tone: "info", nav: ATTENTION_NAV.purchaseOrders, href: "/dashboard/purchase-orders?status=sent", hrefPerms: ["purchase_orders.view"] },
  // ?status=overdue is the DERIVED pseudo-status sharing RECEIVABLE_PO_STATUSES and the same
  // "confirmed ?? expected < start of today" rule as this count — the badge opens exactly its rows,
  // not every sent PO.
  // A STRICT SUBSET of "Deliveries to receive": `expectedDeliveries` selects through the very same
  // `receivableWhere()` and then keeps the rows whose ETA has passed. Both sit on the Purchase Orders
  // row, so adding both counted every late order twice on that badge — the defect the hire predicates
  // are engineered and tested against ("the three Inventory hire badges never count one line twice").
  // It still shows as its own chip, and still lends the row its critical tone; only the number folds in.
  { key: "po.overdue_delivery", label: "Deliveries overdue", perms: ["purchase_orders.view"], tone: "critical", nav: ATTENTION_NAV.purchaseOrders, href: "/dashboard/purchase-orders?status=overdue", subsetOf: "wh.goods_in_waiting" },
  // `?status=awaiting_close`, the DERIVED pseudo-status — not the bare `fully_received` it used to
  // open. A rental order stays `fully_received` forever once its kit arrived, but it cannot be closed
  // until the kit goes back, so the raw status listed rows the Close button refuses. Same predicate
  // the count uses (awaitingClosePoWhere), so chip and list can never disagree.
  { key: "po.awaiting_close", label: "Received — ready to close", perms: ["purchase_orders.close"], tone: "info", nav: ATTENTION_NAV.purchaseOrders, href: "/dashboard/purchase-orders?status=awaiting_close", hrefPerms: ["purchase_orders.view"] },

  // Jobs
  { key: "jobs.rejected", label: "Rejected — reassign", perms: ["jobs.assign"], tone: "critical", nav: ATTENTION_NAV.jobs, href: "/dashboard/jobs?status=rejected", hrefPerms: ["jobs.view"] },
  // ?status=overdue is the DERIVED pseudo-status the office job list shares with the engineer list and
  // the dashboard card — same predicate as this count, so the badge and the screen it opens agree.
  { key: "jobs.overdue", label: "Jobs overdue", perms: ["jobs.view"], tone: "critical", nav: ATTENTION_NAV.jobs, href: "/dashboard/jobs?status=overdue" },
  // NO href. Kit requests are reviewed INSIDE a job (JobDetail → JobKitRequestsReview), so there is no
  // cross-job screen that holds this count. It used to point at the bare job list, which navigated
  // without narrowing anything. The jobs list already carries a per-row pending-kit-request count and
  // the dashboard worklist links each request to its own job — that is the fan-out. If a cross-job
  // review screen is ever built, adding `href` here is the whole change.
  { key: "jobs.kit_requests", label: "Kit requests to review", perms: ["jobs.kit_request.review"], tone: "attention", nav: ATTENTION_NAV.jobs },
  { key: "jobs.awaiting_acceptance", label: "Awaiting engineer acceptance", perms: ["jobs.view"], tone: "info", nav: ATTENTION_NAV.jobs, href: "/dashboard/jobs?status=assigned" },

  // Receiving a delivery starts from the PO, so this navs to Purchase Orders rather than Warehouses:
  // a badge must sit on the row the click LANDS on, and under Warehouses it was the one chip in the
  // catalog that jumped to a different module than its own badge.
  //
  // ?status=receivable is the DERIVED pseudo-status sharing RECEIVABLE_PO_STATUSES with this count.
  // It pointed at `?status=sent` before, which is only the first of the three statuses a warehouse can
  // still book in: the chip read 14 and opened a list of 7. `?status=sent` belongs to
  // po.awaiting_acceptance below — two different queues cannot share one destination.
  //
  // hrefPerms: the destination is another module. A clerk with goods_in.create and no
  // purchase_orders.view still needs to KNOW deliveries are waiting — they just can't be sent to a
  // screen that will refuse them, so for that actor this renders as a number.
  { key: "wh.goods_in_waiting", label: "Deliveries to receive", perms: ["goods_in.create"], tone: "attention", nav: ATTENTION_NAV.purchaseOrders, href: "/dashboard/purchase-orders?status=receivable", hrefPerms: ["purchase_orders.view"] },

  // Warehouse floor. GRN has no sidebar row of its own (it is commented out of the nav), so it rolls
  // up to Warehouses — but `/dashboard/goods-in?status=draft` IS a real filtered list of these rows,
  // so this one keeps a genuine href.
  { key: "wh.grn_drafts", label: "Draft receipts to complete", perms: ["goods_in.complete"], tone: "attention", nav: ATTENTION_NAV.warehouses, href: "/dashboard/goods-in?status=draft", hrefPerms: ["goods_in.view"] },

  // The six below are AGGREGATES ACROSS WAREHOUSES with no cross-warehouse screen: every one of these
  // jobs is done on a warehouse detail page, so "12 to issue" is not a list anyone can open. They
  // carry `warehouseQuery` instead of `href` — the service turns that into a real deep link for an
  // actor scoped to a single warehouse, and leaves them as plain numbers for anyone who can reach
  // several. See the Warehouses list's per-row count for the multi-warehouse fan-out.
  { key: "wh.to_issue", label: "Job kit to issue", perms: ["goods_management.issue"], tone: "attention", nav: ATTENTION_NAV.warehouses, warehouseQuery: "tab=goods" },
  { key: "wh.awaiting_return", label: "Returns to receive", perms: ["goods_management.receive_return"], tone: "attention", nav: ATTENTION_NAV.warehouses, warehouseQuery: "tab=goods" },
  { key: "wh.overdue_holdings", label: "Stock out too long", perms: ["goods_management.view"], tone: "critical", nav: ATTENTION_NAV.warehouses, warehouseQuery: "tab=goods" },
  { key: "wh.van_requests", label: "Field stock requests", perms: ["van_stock_request.review"], tone: "attention", nav: ATTENTION_NAV.warehouses, warehouseQuery: "tab=van" },
  { key: "wh.van_returns", label: "Van returns to scan in", perms: ["van_stock_request.review"], tone: "info", nav: ATTENTION_NAV.warehouses, warehouseQuery: "tab=van" },
  // Both customer-stock queues sit behind their tab's inner POOL toggle, so the tab id alone would
  // open the company (IRM/GRN) pane and show none of the counted rows.
  { key: "wh.customer_intake", label: "Customer stock to receive", perms: ["stock_requests.complete"], tone: "attention", nav: ATTENTION_NAV.warehouses, warehouseQuery: "tab=incoming&pool=customer" },
  // The THIRD pane on the same tab, and the one that had no count at all. Every pane of Incoming
  // stock ends in someone pressing Receive; Company (GRN) and Customer each carried a badge, so a
  // hire arriving at a warehouse was the only receiving job in the product that announced itself
  // nowhere — not on the Warehouses row, not on the tab, not on its own pane, not on the list row.
  //
  // Counts what the pane LISTS (every hire still awaiting delivery here), not `rentals.awaiting_
  // delivery`'s narrower "should already be here" set — see countAwaitingHireDeliveries. The two
  // keys are different jobs for different people and both stay: this is the warehouse's work, that
  // one is the PM's chase, and collapsing them would silence one of the two.
  //
  // the hire-floor keys, because that is what recording the delivery requires — a badge nobody can
  // act on is noise (RULE 1).
  { key: "wh.rental_intake", label: "Hire deliveries to receive", perms: ["rentals.hire.receive", "rentals.hire.settle", "rentals.hire.manage"], tone: "attention", nav: ATTENTION_NAV.warehouses, warehouseQuery: "tab=incoming&pool=rental" },
  { key: "wh.stock_entry_drafts", label: "Received stock to catalogue", perms: ["stock_requests.complete"], tone: "info", nav: ATTENTION_NAV.warehouses, warehouseQuery: "tab=inventory&pool=customer" },

  // Inventory. Both queues are the Reorder workbench, which is the only screen that lists shortfalls
  // as ITEMS — `?status=low_stock` on the stock table could not work for either: it filters
  // per-warehouse BALANCE ROWS against reorderLevel, while these count items against criticalLevel
  // and after netting off incoming cover. An item that is critical because it has no balance row
  // anywhere has nothing for that table to show at all, which is how "Critical stock · 1" came to
  // open an empty list.
  { key: "inv.critical", label: "Critical stock", perms: ["inventory.view"], tone: "critical", nav: ATTENTION_NAV.inventory, href: "/dashboard/inventory?tab=reorder&critical=1", subsetOf: "inv.reorder" },
  { key: "inv.reorder", label: "Items to reorder", perms: ["inventory.view"], tone: "attention", nav: ATTENTION_NAV.inventory, href: "/dashboard/inventory?tab=reorder" },

  // Customers. NO href on either: both are reviewed on a CUSTOMER's detail page (submissions tab /
  // portal users), and no cross-customer queue screen exists — `/dashboard/stock` is the customer's
  // own portal view, not a staff one. The Customers list carries a per-row count instead, which is
  // the fan-out these two need. Adding a staff-side review screen later = adding `href` here.
  { key: "cust.stock_requests", label: "Customer stock requests", perms: ["stock_requests.approve"], tone: "attention", nav: ATTENTION_NAV.customers },
  // Approved, but nobody has chosen the warehouses it will be received at yet — the "Assign
  // warehouses" button on the customer's Submissions tab.
  //
  // This queue had NO key at all. `cust.stock_requests` stops at `pending`, and `wh.customer_intake`
  // counts assignments that already exist, which is exactly what this step creates. So approving a
  // request removed it from every badge in the product while the work was still outstanding: a pile
  // of approved-but-unassigned requests read as an empty desk. Same permission as approving, because
  // the assign endpoint is gated on it too — whoever clears the review queue owns this one.
  { key: "cust.awaiting_assignment", label: "Approved — assign warehouses", perms: ["stock_requests.approve"], tone: "attention", nav: ATTENTION_NAV.customers },
  { key: "cust.portal_invites", label: "Portal invites not accepted", perms: ["customer_portal.resend_invite"], tone: "info", nav: ATTENTION_NAV.customers },
];

// ── SOURCES ────────────────────────────────────────────────────────────────────────────────────
export const ATTENTION_SOURCES: AttentionSource[] = [
  {
    id: "purchase_requests",
    keys: ["prf.awaiting_approval", "prf.awaiting_conversion", "prf.rework"],
    run: async ({ scope }) => {
      const c = await prfRepo.countAttention(scope);
      return { "prf.awaiting_approval": c.awaitingApproval, "prf.awaiting_conversion": c.awaitingConversion, "prf.rework": c.rework };
    },
  },
  {
    id: "purchase_orders",
    keys: ["po.awaiting_approval", "po.awaiting_send", "po.awaiting_acceptance", "po.awaiting_close", "wh.goods_in_waiting", "po.overdue_delivery"],
    run: async ({ scope, userId, now, dayStart }) => {
      const [c, eta] = await Promise.all([
        poRepo.countAttention({ warehouseIds: scope, pmUserId: userId }),
        poRepo.expectedDeliveries(now, dayStart, scope),
      ]);
      return {
        "po.awaiting_approval": c.awaitingApproval,
        "po.awaiting_send": c.awaitingSend,
        "po.awaiting_acceptance": c.awaitingAcceptance,
        "po.awaiting_close": c.awaitingClose,
        "wh.goods_in_waiting": c.receivable,
        "po.overdue_delivery": eta.overdue,
      };
    },
  },
  {
    id: "rentals",
    keys: ["rentals.expiring_soon", "rentals.overdue", "rentals.awaiting_delivery"],
    // Company-wide, not warehouse-scoped: a hire is delivered to a site or a warehouse, and the
    // person who must chase its return is the PM on the order, not whoever holds that warehouse.
    run: async ({ dayStart }) => {
      const [expiring, overdue, awaiting] = await Promise.all([
        poRepo.countExpiringHires(dayStart),
        poRepo.countOverdueHires(dayStart),
        poRepo.countOverdueDeliveryHires(dayStart),
      ]);
      return {
        "rentals.expiring_soon": expiring,
        "rentals.overdue": overdue,
        "rentals.awaiting_delivery": awaiting,
      };
    },
  },
  {
    id: "hire_intake",
    keys: ["wh.rental_intake"],
    // Warehouse-SCOPED, unlike the `rentals` source above: this is the receiving queue at a door the
    // actor holds, so an actor scoped to one warehouse must not see another's arrivals.
    run: async ({ scope }) => ({ "wh.rental_intake": await poRepo.countAwaitingHireDeliveries(scope) }),
  },
  {
    id: "jobs",
    // Jobs are deliberately NOT warehouse-scoped (a job's kit lines can span warehouses), so these
    // are company-wide for every actor — the same rule the activeJobs dashboard card follows.
    keys: ["jobs.rejected", "jobs.awaiting_acceptance", "jobs.overdue"],
    run: async ({ now, timeZone }) => {
      const [c, due] = await Promise.all([jobRepo.countAttention(), jobRepo.dueBreakdown(now, timeZone)]);
      return {
        "jobs.rejected": c.rejected,
        "jobs.awaiting_acceptance": c.awaitingAcceptance,
        "jobs.overdue": due.overdue,
      };
    },
  },
  {
    id: "kit_requests",
    // No warehouse scope exists on a kit request — company-wide by design.
    keys: ["jobs.kit_requests"],
    run: async () => ({ "jobs.kit_requests": await kitRepo.countPending() }),
  },
  {
    id: "goods_in",
    keys: ["wh.grn_drafts"],
    run: async ({ scope }) => ({ "wh.grn_drafts": await grnRepo.count({ status: "draft", warehouseIds: scope }) }),
  },
  {
    id: "goods_management",
    keys: ["wh.to_issue", "wh.awaiting_return", "wh.overdue_holdings"],
    run: async ({ scope, actor }) => {
      const [c, overdue] = await Promise.all([gmRepo.countGoodsAttention(scope), gmService.getOverdueSummary(actor)]);
      return { "wh.to_issue": c.toIssue, "wh.awaiting_return": c.awaitingReturn, "wh.overdue_holdings": overdue.count };
    },
  },
  {
    id: "van_stock",
    keys: ["wh.van_requests", "wh.van_returns"],
    run: async ({ scope }) => {
      const [pending, returns] = await Promise.all([vsrRepo.countPending(scope), vsrRepo.countReturnsToScan(scope)]);
      return { "wh.van_requests": pending, "wh.van_returns": returns };
    },
  },
  {
    id: "customers",
    keys: ["cust.stock_requests", "cust.awaiting_assignment", "cust.portal_invites", "wh.customer_intake", "wh.stock_entry_drafts"],
    run: async ({ scope }) => {
      const c = await customerRepo.countAttention(scope);
      return {
        "cust.stock_requests": c.stockRequestsPending,
        "cust.awaiting_assignment": c.stockRequestsAwaitingAssignment,
        "cust.portal_invites": c.portalInvitesPending,
        "wh.customer_intake": c.assignmentsOpen,
        "wh.stock_entry_drafts": c.stockEntryDrafts,
      };
    },
  },
  {
    id: "inventory",
    keys: ["inv.critical", "inv.reorder"],
    // ONE source of truth for both keys, and the same one the Reorder workbench renders:
    // `count` is its actionable rows, `criticalCount` is those rows with the Critical flag — exactly
    // what `?critical=1` leaves on screen. They were two different reads before (criticalCount came
    // from lowStockCounts, which measures items against criticalLevel with no netting off incoming
    // cover and in a different unit again), so the badge and the list could not agree.
    // getReorderSummary carries its own 30s scope-keyed cache, shared with the dashboard card.
    run: async ({ actor }) => {
      const reorder = await inventoryService.getReorderSummary(actor);
      return { "inv.critical": reorder.criticalCount, "inv.reorder": reorder.count };
    },
  },
];

// ── ENTITY SOURCES — the same work, split per warehouse / per customer ─────────────────────────
//
// These back the per-row counts on the Warehouses and Customers lists, and the warehouse detail tab
// counts. They exist because the six warehouse queues and the two customer queues have no
// cross-entity screen: the aggregate is not openable, so the number has to be delivered on the row
// where it CAN be acted on.
//
// NOT covered here, on purpose:
//   • wh.overdue_holdings — the overdue read starts from every open job and nets each one's whole
//     movement history; there is no warehouse-grouped form of it, and running it once per warehouse
//     would be N of the most expensive read in the module. It also overlaps almost entirely with
//     to_issue / awaiting_return (stock is overdue precisely because it is still out), so adding it
//     would inflate a row rather than inform it. The warehouse's own Goods tab still shows it.
//   • wh.goods_in_waiting — it navs to Purchase Orders now and has a working cross-warehouse screen
//     of its own, so it needs no per-row fan-out.
//
// ROW COUNTS ARE NOT A DECOMPOSITION OF THE BADGE. Work that spans two warehouses (a job kitted from
// both, a split restock) is real work at each and is counted at each, so the rows can sum higher than
// the sidebar number. That is why the Warehouses page no longer shows the aggregate chip bar next to
// these rows — the two would look like they should reconcile, and they must not be read that way.
export const ATTENTION_ENTITY_SOURCES: AttentionEntitySource[] = [
  {
    id: "goods_in_by_warehouse",
    dimension: "warehouse",
    keys: ["wh.grn_drafts"],
    run: async ({ scope }) => byEntity({ "wh.grn_drafts": await grnRepo.countDraftsByWarehouse(scope) }),
  },
  {
    id: "goods_management_by_warehouse",
    dimension: "warehouse",
    keys: ["wh.to_issue", "wh.awaiting_return"],
    run: async ({ scope }) => {
      const c = await gmRepo.countGoodsAttentionByWarehouse(scope);
      return byEntity({ "wh.to_issue": c.toIssue, "wh.awaiting_return": c.awaitingReturn });
    },
  },
  {
    id: "van_stock_by_warehouse",
    dimension: "warehouse",
    keys: ["wh.van_requests", "wh.van_returns"],
    run: async ({ scope }) => {
      const [pending, returns] = await Promise.all([
        vsrRepo.countPendingByWarehouse(scope),
        vsrRepo.countReturnsToScanByWarehouse(scope),
      ]);
      return byEntity({ "wh.van_requests": pending, "wh.van_returns": returns });
    },
  },
  {
    id: "customer_stock_by_warehouse",
    dimension: "warehouse",
    keys: ["wh.customer_intake", "wh.stock_entry_drafts"],
    run: async ({ scope }) => {
      const c = await customerRepo.countIntakeByWarehouse(scope);
      return byEntity({ "wh.customer_intake": c.assignmentsOpen, "wh.stock_entry_drafts": c.stockEntryDrafts });
    },
  },
  {
    id: "hire_intake_by_warehouse",
    dimension: "warehouse",
    keys: ["wh.rental_intake"],
    run: async ({ scope }) =>
      byEntity({ "wh.rental_intake": await poRepo.countAwaitingHireDeliveriesByWarehouse(scope) }),
  },
  {
    id: "customers_by_customer",
    dimension: "customer",
    keys: ["cust.stock_requests", "cust.awaiting_assignment", "cust.portal_invites"],
    // No warehouse scope: neither queue is warehouse-bound (a stock request has not been assigned to
    // one yet, and a portal invite never is), matching the flat counts in the `customers` source.
    run: async () => {
      const c = await customerRepo.countAttentionByCustomer();
      return byEntity({
        "cust.stock_requests": c.stockRequestsPending,
        "cust.awaiting_assignment": c.stockRequestsAwaitingAssignment,
        "cust.portal_invites": c.portalInvitesPending,
      });
    },
  },
];
