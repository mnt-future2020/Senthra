import type { AuditActor } from "#modules/audit/audit.service.js";
import { badRequest, conflict, notFound } from "../../utils/http-error.js";
import { parseFilterDate, startOfDayIn } from "../../utils/filter-date.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";
import { getCompanyTimezone, getOverdueAfterDays } from "#modules/settings/settings.service.js";
import * as jobRepo from "#modules/job/job.repository.js";
import type { JobWithRelations } from "#modules/job/job.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as inventoryService from "#modules/inventory/inventory.service.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as rentalItemRepo from "#modules/rental-item/rental-item.repository.js";
import * as custodyExitRepo from "#modules/purchase-order/hireCustodyExit.repository.js";
import { emitHireUpdated } from "#modules/purchase-order/rentalHire.realtime.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import { allocateFromHires, hireIssuable, totalAvailable } from "#modules/purchase-order/rentalHire.allocation.js";
import * as transferRepo from "#modules/engineer-transfer/engineer-transfer.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import * as goodsManagementRepo from "./goods-management.repository.js";
import { getOpenDemand } from "./demand.js";
import type { CloseReconcileInput, PostMovementInput, ReportDamageInput, RestoreDamagedInput, ScanLookupInput } from "./goods-management.validation.js";
import { withTransaction } from "../../lib/prisma.js";
import { notify } from "#modules/notification/notification.service.js";
import { emitAttentionChanged, emitToUser, emitToRoom, OFFICE_JOBS_ROOM } from "../../lib/realtime.js";

// Issue / return / reconcile each move a goods attention queue (to-issue, awaiting-return, overdue
// holdings), so the office event and the attention signal fire together — see emitJobsRoom.
function emitGoodsRoom(event: string, payload: unknown): void {
  emitToRoom(OFFICE_JOBS_ROOM, event, payload);
  emitAttentionChanged("goods_management");
}

/** One hire a scan touches, and this hire's share of the units the scan may move. */
export interface ScanHire {
  purchaseOrderRentalLineId: string;
  poCode: string | null;
  hireEndDate: string | null;
  overdue: boolean;
  /**
   * ISSUE: units to take off this hire. RETURN: units that may go back on it. Either way it is the
   * cap for a movement line naming this hire, already spent against what the KIT LINE needs or owes —
   * so the entries sum to at most that, and a panel may stage every one of them.
   */
  qty: number;
  /**
   * ISSUE only: this hire's own issuable stock, which is a different question from `qty` — a hire
   * holding 4 against a line that needs 3 lends 3 and still HAS 4. The panel prints it as "Available",
   * so conflating the two would have the depot's stock shrink to whatever this job happened to ask for.
   */
  available?: number;
}

export interface ScanMatch {
  source: "irm" | "customer" | "rental";
  irmItemId?: string;
  customerStockEntryId?: string;
  rentalItemId?: string;
  /**
   * For a rental: WHICH HIRE the scan resolved to, and what the panel must send back on post.
   *
   * Chosen server-side by the allocator (earliest deadline first) rather than offered as a choice,
   * so the units committed are the ones the preview showed. `hire` carries the human context the
   * warehouse needs to see before handing kit over — which order it belongs to and when it is due
   * back — because a rental is the one thing on a kit list with a date attached to it.
   */
  purchaseOrderRentalLineId?: string;
  /**
   * The hire being handed over. `overdue` is the one thing here that is a judgement rather than a
   * fact off the row: the hire was due back before today, in COMPANY time, and issuing it puts it
   * further past its return date.
   *
   * Surfaced, not blocked. The allocator picks the soonest deadline first, so an overdue hire is
   * picked FIRST — which is right (it is the one to get back into circulation), but it means the
   * warehouse would otherwise hand out the most-overdue unit with nothing on screen saying so. The
   * job may genuinely need the tester today and the return trip is a separate logistics problem, so
   * refusing would strand real work; the person at the counter is simply the last one who can notice.
   */
  hire?: { poCode: string | null; hireEndDate: string | null; itemName: string; overdue: boolean } | null;
  /**
   * RENTALS ONLY, BOTH LEGS — every hire this scan touches, earliest deadline first, with the bound
   * one (`hire` above) at the head. Absent on every non-rental source.
   *
   * A movement line is committed against ONE hire, and that is not negotiable: the units came off a
   * specific order. But a kit line can legitimately draw the same catalogue item off several orders,
   * and reporting only the bound one made the rest invisible:
   *
   *   RETURN — a line reading "issued 2" offered "Held: 1", and the second unit surfaced only if
   *   somebody thought to scan again AFTER posting.
   *   ISSUE  — a line for 12 spread over four orders took four scan→type→Post cycles, each capped at
   *   a number the warehouse discovered by being refused.
   *
   * This is the panel's licence to stage a row per hire from one scan, on either leg.
   *
   * The quantities are already spent in order against what the KIT LINE needs (issue) or still has
   * out (return), so they sum to at most that — a panel may stage all of them without the post
   * refusing the surplus at the till. See `ScanHire.qty` and `ScanHire.available`, which are two
   * different numbers on the issue leg.
   */
  hires?: ScanHire[];
  jobKitLineId?: string;
  itemName: string;
  uom?: string | null;
  plannedQty: number;
  alreadyIssued: number;
  remainingIssuable: number;
  // Qty the engineer still holds for this line (issued − used − already-returned) — the cap for returns.
  heldByEngineer: number;
  available: number; // current warehouse availability of this item
}

// Sum the qty already issued for a kit line (issue lines minus return lines pointing at it).
// The movement fields the tally helpers below actually read. Typed structurally rather than as
// `findMovementsByJob`'s full row so BOTH shapes satisfy them: the singular query still joins the item
// and job relations for the detail views, while the batch query (findMovementsByJobs) fetches only
// these. Naming what the arithmetic needs is also what stops the lean query being widened again
// "because the type says so".
type MovementTally = {
  status: string;
  direction: string;
  warehouseId: string | null;
  // `condition` ("good" | "damaged") is a plain column, not a join — the reconcile tally splits
  // returns on it, and carrying one scalar costs nothing next to the relations this type drops.
  items: { jobKitLineId: string | null; qty: number; condition: string }[];
};

function issuedForKitLine(movements: readonly MovementTally[], kitLineId: string): number {
  let n = 0;
  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (l.jobKitLineId !== kitLineId) continue;
      if (m.direction === "issue") n += l.qty;
      if (m.direction === "return") n -= l.qty; // a return frees the planned allocation back
    }
  }
  return n;
}

// Split a kit line's posted movements into GROSS issued / used (consumed, incl. lost) / returned.
// Powers the queue's per-item lifecycle status (issued → awaiting return → returned/used).
function kitLineSplit(movements: readonly MovementTally[], kitLineId: string): { issued: number; used: number; returned: number } {
  let issued = 0;
  let used = 0;
  let returned = 0;
  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (l.jobKitLineId !== kitLineId) continue;
      if (m.direction === "issue") issued += l.qty;
      else if (m.direction === "consume") used += l.qty;
      else if (m.direction === "return") returned += l.qty;
    }
  }
  return { issued, used, returned };
}

export interface KitLineTally {
  issued: number;
  used: number; // consumed/used on site (incl. lost write-offs)
  returned: number;
  remaining: number; // still held by the engineer = issued − used − returned
  // ── Hire deadline (RENTAL lines only; null on every other line type) ────────────────────────
  //
  // The date the engineer holding this kit has to get it back to the warehouse by, so the warehouse
  // can return it to the provider. It is the ONE fact that makes a rental line different from an IRM
  // one: an IRM cable in a van costs nothing and can be written off, a hire keeps billing and is owed
  // to somebody else.
  //
  // Resolved from THIS JOB'S OWN MOVEMENTS intersected with the engineer's live holdings — never from
  // an engineer-wide aggregate. That distinction is the whole point. A hire's deadline belongs to the
  // hire, and an engineer can be holding the same catalogue item off two different orders with two
  // different dates. Reading the earliest across everything they hold put ANOTHER job's deadline —
  // and another job's overdue flag — on this job's row, about units this job never received.
  //
  // Where THIS job legitimately drew one item off several hires, this is the earliest of those: it is
  // the one that bites first, and `hires` below carries the rest so the row can offer the breakdown
  // instead of hiding it.
  //
  // Null on a rental line whose units are all back (nothing held ⇒ no deadline to meet).
  hireEndDate: Date | null;
  /**
   * Every hire THIS job still has units out on, earliest deadline first.
   *
   * Empty on non-rental lines and on a rental line that is fully back. Present so a row showing one
   * date can say honestly that there is another behind it — the previous single-date row simply
   * dropped the second hire, and its deadline with it.
   */
  hires: {
    purchaseOrderRentalLineId: string;
    poCode: string | null;
    hireEndDate: Date | null;
    qty: number;
    /**
     * Late as of THIS request's company-local today — per hire, which `hireOverdue` beside it cannot
     * say. That flag describes the LINE (its soonest hire), so a consumer counting late UNITS off it
     * counts the whole line: 1 unit a month overdue beside 2 not due until December read as "3 past
     * their return date, bring them all back". Only a per-hire flag can answer "how many".
     */
    overdue: boolean;
  }[];
  // Resolved SERVER-side against the company timezone, never from a client clock — the same rule the
  // scan panel follows. A browser in another zone would otherwise disagree with the warehouse about
  // which day it is, on the one field whose whole purpose is naming a day.
  hireOverdue: boolean;
}

/**
 * The only parts of a job getJobKitTallies reads. Structural on purpose: a caller that ALREADY holds
 * the job — the customer portal fetches a narrow projection of it to render the page, the delete
 * guard has just loaded the whole thing — can hand it over instead of paying for a second, full
 * `findById` (which loads every kit line with its irmItem join and each pickup warehouse's whole
 * address block, for four fields).
 */
export interface KitTallyJob {
  assignedEngineerId: string | null;
  kitLines: { id: string; lineType: string; irmItemId: string | null; rentalItemId: string | null; customerStockEntryId: string | null }[];
}

/**
 * What one engineer is holding on hire, summed to the CATALOGUE item.
 *
 * Custody is stored per HIRE (two testers on two orders are two rows), but a kit line names the
 * catalogue item, so the tally that caps a line's "remaining" has to be per item. Summing is right:
 * the engineer is holding two testers either way, and which hire each came off is the return scan's
 * question, not this one's.
 */
/**
 * Free hired units per `${rentalItemId}|${warehouseId}`, summed from the LIVE HIRES of those items.
 *
 * The rental analogue of `inventoryRepo.findBalancesByItemsAndWarehouses`, and the reason it has to be
 * computed rather than read: a hire has no stock balance row, deliberately. What a depot can hand out
 * is `received − returned − issued` totalled across every live hire delivered there.
 *
 * One query for the whole page, matching how every other lookup on this path is batched.
 */
/**
 * Start of TODAY in the company timezone — the one date every hire-window comparison in a request is
 * judged against.
 *
 * A named helper rather than the `startOfDayIn(await getCompanyTimezone(), new Date())` pair written
 * out at each site, because "resolve it once per request" is a correctness rule here, not tidiness: a
 * multi-line scan posted at 23:59:59.9 that re-derived the date per line could judge line one against
 * yesterday and line two against today, and issue half a hire it had just refused. Callers resolve
 * this once and pass the value down.
 */
async function companyTodayStart(): Promise<Date> {
  return startOfDayIn(await getCompanyTimezone(), new Date());
}

async function rentalPoolByItemAndWarehouse(
  rentalItemIds: string[],
  warehouseIds: string[],
  // Company-timezone start of today, resolved once by the caller. Present because this pool answers
  // "what can this depot hand out", so an EXPIRED hire does not belong in it however many units of it
  // are physically on the shelf — see `issuableWhere`.
  todayStart: Date,
): Promise<Map<string, number>> {
  const pool = new Map<string, number>();
  if (rentalItemIds.length === 0) return pool;
  for (const h of await poRepo.findIssuableHiresByRentalItems(rentalItemIds, todayStart, warehouseIds)) {
    const key = `${h.rentalItemId}|${h.warehouseId}`;
    pool.set(key, (pool.get(key) ?? 0) + hireIssuable(h));
  }
  return pool;
}

/**
 * What one engineer is holding on hire, per CATALOGUE item: how many, and the soonest deadline
 * among the hires those units sit on.
 *
 * Both facts come off the same rows, so the deadline rides along for free — the alternative was a
 * second pass over the holdings (or worse, a per-line lookup) on a path that already renders the
 * whole job pack. The repository filters `quantityOnHand > 0` and orders by `hireEndDate asc`, so
 * "soonest" is simply the first one seen; the explicit min below does not rely on that ordering,
 * because a caller reading the earliest deadline should not silently depend on a repository's
 * `orderBy` staying put.
 */
type RentalHeld = { qty: number; hireEndDate: Date | null };
async function rentalHeldByItem(engineerId: string): Promise<Map<string, RentalHeld>> {
  return rentalHeldFrom(await rentalCustodyRepo.findRentalHoldingsByEngineer(engineerId));
}

/** The per-item roll-up, split out so a caller that already loaded the holdings does not re-query. */
function rentalHeldFrom(rows: { rentalItemId: string | null; quantityOnHand: number; hireEndDate: Date | null }[]): Map<string, RentalHeld> {
  const held = new Map<string, RentalHeld>();
  for (const h of rows) {
    if (!h.rentalItemId) continue;
    const cur = held.get(h.rentalItemId);
    const soonest =
      !cur?.hireEndDate ? h.hireEndDate
      : !h.hireEndDate ? cur.hireEndDate
      : h.hireEndDate < cur.hireEndDate ? h.hireEndDate
      : cur.hireEndDate;
    held.set(h.rentalItemId, { qty: (cur?.qty ?? 0) + h.quantityOnHand, hireEndDate: soonest });
  }
  return held;
}

/** One hire, and what THIS job still has out on it. */
export interface JobHireOutstanding {
  purchaseOrderRentalLineId: string;
  /** The ORDER a hire action is addressed to — declaring units lost posts against it, not the holding. */
  purchaseOrderId: string;
  poCode: string | null;
  itemName: string;
  hireEndDate: Date | null;
  qty: number;
}

/**
 * WHICH HIRES a given job still has units out on, and how many — the movements ∩ holdings intersect.
 *
 * Both halves are load-bearing and neither works alone.
 *
 * The MOVEMENTS say which hires this job drew from and how much of each is unreturned: every rental
 * movement line carries `purchaseOrderRentalLineId`, so "issued off hire A, returned to hire A" nets
 * per hire without guessing. That is what scopes the answer to this job — an engineer-wide read cannot,
 * and putting another job's hire on this job's row is exactly the bug this replaces.
 *
 * The HOLDINGS say what the engineer is really carrying, and carry the deadline snapshot. They are
 * still needed because a return is resolved against the ENGINEER's holding rather than against a job:
 * units issued on job A can be scanned back while job B's panel is open, and the movement ledger for
 * job A would still read "outstanding". Clamping to the live holding is what stops a row insisting on
 * units that are already home.
 *
 * Returned earliest-deadline first, which is the order every hire surface in this codebase reads in.
 */
export function jobHiresOutstanding(
  movements: { status: string; direction: string; items: { purchaseOrderRentalLineId?: string | null; qty: number }[] }[],
  holdings: {
    purchaseOrderRentalLineId: string;
    rentalItemId: string | null;
    itemName: string;
    poCode: string | null;
    hireEndDate: Date | null;
    quantityOnHand: number;
    purchaseOrderRentalLine?: { purchaseOrderId: string };
  }[],
  kitLineIds?: Set<string>,
): Map<string, JobHireOutstanding[]> {
  const netByHire = new Map<string, number>();
  for (const m of movements) {
    if (m.status !== "posted") continue;
    const sign = m.direction === "issue" ? 1 : m.direction === "return" ? -1 : 0;
    if (sign === 0) continue;
    for (const l of m.items) {
      if (!l.purchaseOrderRentalLineId) continue;
      if (kitLineIds && !kitLineIds.has((l as { jobKitLineId?: string | null }).jobKitLineId ?? "")) continue;
      netByHire.set(l.purchaseOrderRentalLineId, (netByHire.get(l.purchaseOrderRentalLineId) ?? 0) + sign * l.qty);
    }
  }

  const byItem = new Map<string, JobHireOutstanding[]>();
  for (const h of holdings) {
    if (!h.rentalItemId) continue;
    const onJob = netByHire.get(h.purchaseOrderRentalLineId) ?? 0;
    // The lower of the two: what this job has not brought back, and what the engineer actually holds.
    const qty = Math.min(Math.max(0, onJob), h.quantityOnHand);
    if (qty <= 0) continue;
    const row = {
      purchaseOrderRentalLineId: h.purchaseOrderRentalLineId,
      // Empty only when a caller passed holdings loaded without the relation — the screens that act on
      // a hire always have it, and a row without it simply cannot offer the action.
      purchaseOrderId: h.purchaseOrderRentalLine?.purchaseOrderId ?? "",
      poCode: h.poCode,
      itemName: h.itemName,
      hireEndDate: h.hireEndDate,
      qty,
    };
    const list = byItem.get(h.rentalItemId);
    if (list) list.push(row);
    else byItem.set(h.rentalItemId, [row]);
  }
  for (const list of byItem.values()) {
    list.sort((a, b) => (a.hireEndDate?.getTime() ?? Infinity) - (b.hireEndDate?.getTime() ?? Infinity));
  }
  return byItem;
}

// Per-kit-line goods tallies for a single job, keyed by jobKitLineId. Used on the job-detail "job
// pack" views so the engineer/office can see issued / returned / remaining per item.
export async function getJobKitTallies(jobId: string, prefetched?: KitTallyJob): Promise<Record<string, KitLineTally>> {
  // Omitting `prefetched` keeps the original behaviour exactly — every existing caller is unchanged.
  const job = prefetched ?? (await jobRepo.findById(jobId));
  const movements = await goodsManagementRepo.findMovementsByJob(jobId);
  const acc: Record<string, { issued: number; returned: number; consumed: number }> = {};
  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (!l.jobKitLineId) continue;
      const e = (acc[l.jobKitLineId] ??= { issued: 0, returned: 0, consumed: 0 });
      if (m.direction === "issue") e.issued += l.qty;
      else if (m.direction === "return") e.returned += l.qty;
      else if (m.direction === "consume") e.consumed += l.qty;
    }
  }

  // "Remaining" must reflect what the engineer ACTUALLY still holds (global per item), not raw issued −
  // returned − used. A unit returned at another warehouse, or handed back under another job (a shared
  // customer-stock entry), correctly shows remaining 0 here too — matching the scan / queue / reconcile.
  const engId = job?.assignedEngineerId ?? null;
  const irmHeld = new Map<string, number>();
  const cseHeld = new Map<string, number>();
  // Per CATALOGUE ITEM across everything the engineer holds — the cap for `remaining`, which is
  // deliberately a global figure (a unit returned at another warehouse, or under another job, is
  // genuinely no longer held).
  let rentalHeld = new Map<string, RentalHeld>();
  // Per catalogue item, but scoped to THIS JOB's own hires — what the deadline is read from. See
  // jobHiresOutstanding for why the two are different questions.
  let jobHires = new Map<string, JobHireOutstanding[]>();
  if (engId) {
    for (const b of await engineerStockRepo.findEngineerBalances(engId)) irmHeld.set(b.irmItemId, b.quantityOnHand);
    for (const h of await goodsManagementRepo.findCustomerHoldingsByEngineer(engId)) cseHeld.set(h.customerStockEntryId, h.quantityOnHand);
    const holdings = await rentalCustodyRepo.findRentalHoldingsByEngineer(engId);
    rentalHeld = rentalHeldFrom(holdings);
    jobHires = jobHiresOutstanding(movements as never, holdings);
  }
  // Resolved ONCE for the whole job, and only when a rental line is actually present — this function
  // runs on the queue, the job pack and the start gate, and getCompanyTimezone is a settings read.
  const hasRental = (job?.kitLines ?? []).some((kl) => kl.lineType === "rental");
  const todayStart = hasRental ? startOfDayIn(await getCompanyTimezone(), new Date()) : null;

  // Distribute each item's real held across its kit lines (capped at each line's raw remaining), so the
  // per-line "remaining" sums to the engineer's true holding. Misc lines aren't engineer-tracked, so
  // they keep their raw remaining. Keyed by current kit lines (orphaned movements are ignored).
  const out: Record<string, KitLineTally> = {};
  const groups = new Map<string, KitTallyJob["kitLines"]>();
  for (const kl of job?.kitLines ?? []) {
    const key = kl.irmItemId
      ? `irm:${kl.irmItemId}`
      : kl.rentalItemId
        ? `rental:${kl.rentalItemId}`
        : kl.customerStockEntryId
          ? `cse:${kl.customerStockEntryId}`
          : `misc:${kl.id}`;
    const g = groups.get(key);
    if (g) g.push(kl);
    else groups.set(key, [kl]);
  }
  for (const group of groups.values()) {
    const rental = group[0].rentalItemId ? rentalHeld.get(group[0].rentalItemId) : undefined;
    let remainingHeld = group[0].lineType === "misc"
      ? Number.MAX_SAFE_INTEGER // misc isn't engineer-tracked → keep its raw remaining
      : group[0].irmItemId
        ? irmHeld.get(group[0].irmItemId) ?? 0
        : group[0].rentalItemId
          ? rental?.qty ?? 0
          : cseHeld.get(group[0].customerStockEntryId!) ?? 0;
    for (const kl of group) {
      const e = acc[kl.id] ?? { issued: 0, returned: 0, consumed: 0 };
      const rawRemaining = Math.max(0, e.issued - e.returned - e.consumed);
      const remaining = Math.min(rawRemaining, remainingHeld);
      remainingHeld -= remaining;
      // The deadline rides on THIS JOB'S hires, so it appears only while this job's units are actually
      // out. A rental line fully returned shows no date: there is nothing left to bring back, and a
      // date still sitting there would read as an outstanding obligation.
      //
      // `hires` is already earliest-first, so the head of it IS the deadline that bites first — and the
      // tail is what the row needs to admit that a second hire is behind the one it shows.
      const lineHires = (kl.lineType === "rental" && remaining > 0 && kl.rentalItemId ? jobHires.get(kl.rentalItemId) ?? [] : []).map((h) => ({
        ...h,
        // Judged HERE rather than inside jobHiresOutstanding, which stays a pure movements∩holdings
        // intersection with no clock in it. Same `todayStart` as `hireOverdue` below, so the two can
        // never disagree about which day it is.
        overdue: !!(h.hireEndDate && todayStart && h.hireEndDate.getTime() < todayStart.getTime()),
      }));
      const hireEndDate = lineHires[0]?.hireEndDate ?? null;
      out[kl.id] = {
        issued: e.issued,
        used: e.consumed,
        returned: e.returned,
        remaining,
        hireEndDate,
        hires: lineHires,
        hireOverdue: !!(hireEndDate && todayStart && hireEndDate.getTime() < todayStart.getTime()),
      };
    }
  }
  return out;
}

// Total qty an engineer still holds AGAINST active jobs, per IRM item: issued (warehouse OR van-
// attributed) − used (incl. lost write-offs) − returned, summed over every goods-active job assigned to
// them. This is the slice of their van holding that must go back through the job's Close & Reconcile —
// so the field-stock RETURN flow subtracts it, and an engineer can never hand job stock back outside its
// job (which would strand it). Reuses kitLineSplit — the exact movement math Goods Management shows as
// "held" — so this figure can never drift from the job side. Customer stock is a separate pool (its own
// holdings), never field-returnable, so it isn't considered here.
export async function jobCommittedByEngineer(engineerId: string): Promise<Map<string, number>> {
  const committed = new Map<string, number>();
  const jobs = await jobRepo.findActiveByEngineerWithKitLines(engineerId);
  if (jobs.length === 0) return committed;
  const movesByJob = new Map<string, Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJobs>>>();
  for (const m of await goodsManagementRepo.findMovementsByJobs(jobs.map((j) => j.id))) {
    const list = movesByJob.get(m.jobId);
    if (list) list.push(m);
    else movesByJob.set(m.jobId, [m]);
  }
  for (const job of jobs) {
    const moves = movesByJob.get(job.id) ?? [];
    for (const kit of job.kitLines ?? []) {
      if (kit.lineType !== "irm" || !kit.irmItemId) continue;
      const { issued, used, returned } = kitLineSplit(moves, kit.id);
      const held = Math.max(0, issued - used - returned);
      if (held > 0) committed.set(kit.irmItemId, (committed.get(kit.irmItemId) ?? 0) + held);
    }
  }
  return committed;
}

// Current goods-lifecycle status for a job ("not_issued" if no stock has moved yet). The job module
// uses this to lock the kit list once stock has been issued (changing it would orphan movements).
// Cancelling a job with stock still out. Called by jobs' cancelJob, best-effort on its side: a failure
// here must not cost the planner their cancel, and the job stays on the overdue chase list either way
// (findGoodsActiveJobIds keeps cancelled), so nothing goes unseen. Moving to `awaiting_return` is what
// unlocks postReturn's normal scan-in and, once the engineer has handed back what they can,
// closeReconcile's write-off for anything that never comes home.
export async function openReturnsOnCancel(jobId: string): Promise<void> {
  await goodsManagementRepo.openReturnOnCancel(jobId);
}

export async function getGoodsStatus(jobId: string): Promise<string> {
  const summary = await goodsManagementRepo.getSummary(jobId);
  return summary?.goodsStatus ?? "not_issued";
}

// Goods-lifecycle status for many jobs in ONE query, keyed by jobId (missing → "not_issued"). Lets
// the jobs list show each job's issuance state without an N+1 over the summary collection.
export async function getGoodsStatusByJobs(jobIds: string[]): Promise<Map<string, string>> {
  const summaries = await goodsManagementRepo.getSummariesByJobs(jobIds);
  return new Map(summaries.map((s) => [s.jobId, s.goodsStatus]));
}

// ── Open demand (cross-job stock commitments) ───────────────────────────────────────────────────
// MOVED to ./demand.ts — a leaf module (repo imports only), so the Reorder workbench in
// inventory.service can consume the SAME calculation without a service↔service import cycle
// (this service already imports inventory.service). Re-exported here so existing callers
// (controller, tests, the Demand board below) keep their import path.
export { getOpenDemand } from "./demand.js";
export type { DemandEntry } from "./demand.js";

export interface WarehouseDemandRow {
  source: "irm" | "customer" | "rental";
  itemName: string;
  inStock: number; // current free warehouse stock (on-hand − reserved / customer entry qty)
  planned: number; // open demand across active jobs
  free: number; // inStock − planned (negative ⇒ short)
}

// Demand board for ONE warehouse: every item that active jobs plan to draw FROM this warehouse, with
// its current stock vs total planned, shortfalls first. Reuses getOpenDemand so the numbers always
// match the planner's "free" figure.
export async function getWarehouseDemand(warehouseId: string): Promise<WarehouseDemandRow[]> {
  const demand = [...(await getOpenDemand()).values()].filter((d) => d.warehouseId === warehouseId);
  if (demand.length === 0) return [];

  const irmIds = demand.filter((d) => d.irmItemId).map((d) => d.irmItemId!);
  const cseIds = demand.filter((d) => d.customerStockEntryId).map((d) => d.customerStockEntryId!);
  // THREE pools, matching the three getOpenDemand emits. Without the rental arm a hired item found no
  // stock lookup at all: it has no irmItemId, so it fell to `cseQty.get(null)` → 0, was labelled
  // `customer`, and came out as `free = −demand`. This list sorts most-negative first, so every hire
  // planned from this warehouse pinned to the TOP of the board as a shortfall that did not exist.
  const rentalIds = demand.filter((d) => d.rentalItemId).map((d) => d.rentalItemId!);
  const [balances, cseEntries, rentalPool] = await Promise.all([
    inventoryRepo.findBalancesByItemsAndWarehouses(irmIds, [warehouseId]),
    goodsManagementRepo.findCustomerStockEntriesByIds(cseIds),
    // Same helper the planner's availability check uses, so the two figures always agree:
    // received − returned − issued, over the ISSUABLE hires delivered to THIS warehouse.
    rentalPoolByItemAndWarehouse(rentalIds, [warehouseId], await companyTodayStart()),
  ]);
  const balByItem = new Map(balances.map((b) => [b.irmItemId, b]));
  const cseQty = new Map(cseEntries.map((e) => [e.id, e.quantity]));

  return demand
    .map((d) => {
      const inStock = d.irmItemId
        ? (balByItem.get(d.irmItemId)?.quantityOnHand ?? 0) - (balByItem.get(d.irmItemId)?.quantityReserved ?? 0)
        : d.rentalItemId
          ? rentalPool.get(`${d.rentalItemId}|${warehouseId}`) ?? 0
          : cseQty.get(d.customerStockEntryId!) ?? 0;
      const source = d.irmItemId ? ("irm" as const) : d.rentalItemId ? ("rental" as const) : ("customer" as const);
      return { source, itemName: d.itemName, inStock, planned: d.demand, free: inStock - d.demand };
    })
    .sort((a, b) => a.free - b.free); // shortfalls (most negative free) first
}

// Qty on a kit line that reached the engineer from another engineer's VAN (a completed job-scoped
// transfer), keyed by kit-line id. Pending transfers are excluded — nothing has physically moved yet.
async function completedVanQtyByKitLine(kitLineIds: string[]): Promise<Map<string, number>> {
  const byLine = await transferRepo.findVanSourcesByKitLines(kitLineIds);
  const out = new Map<string, number>();
  for (const [lineId, sources] of byLine) {
    out.set(lineId, sources.filter((s) => s.status === "completed").reduce((n, s) => n + s.quantity, 0));
  }
  return out;
}

// A return may normally only be scanned at the kit line's own warehouse: that warehouse released the
// stock, so it must be the one credited back, or its ledger gains units it never issued while the
// real issuer stays short.
//
// Van-sourced stock is different — it came engineer→engineer and NO warehouse ever released it, so
// none is owed it back. Handing it in anywhere is a clean gain for whichever warehouse receives it.
//
// Kit lines MERGE sources (2 collected from a warehouse + 3 from a van become one row), so a line can
// owe part of itself to its home warehouse and none of the rest. This computes how many units of ONE
// kit line may still be returned AWAY from its home. Only the van portion qualifies, and it's capped
// conservatively — consumption and any prior away-from-home returns are assumed to have used the van
// units first — so the running total of away-from-home returns can never exceed the van quantity.
// That guarantees the warehouse-owed part is always brought home, never mis-credited elsewhere. We
// can't tell one physical box from another; this is the safe accounting, not a per-unit truth.
function vanReturnableAwayFromHome(
  movements: readonly MovementTally[],
  kitLineId: string,
  homeWarehouseId: string | null,
  vanQty: number,
): number {
  let used = 0;
  let awayReturned = 0;
  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (l.jobKitLineId !== kitLineId) continue;
      if (m.direction === "consume") used += l.qty;
      else if (m.direction === "return" && m.warehouseId !== homeWarehouseId) awayReturned += l.qty;
    }
  }
  return Math.max(0, vanQty - used - awayReturned);
}

// For a return being scanned at a warehouse that ISN'T a kit line's home: find the kit line for the
// item that can still take a return here (its van portion), and how many units it may take. Picks the
// line with the most remaining allowance when the item is homed at several. Null ⇒ nothing here.
async function findAwayReturnKitLine<T extends { id: string; warehouseId: string | null }>(
  candidates: T[],
  movements: readonly MovementTally[],
): Promise<{ kit: T; cap: number } | null> {
  if (candidates.length === 0) return null;
  const vanQty = await completedVanQtyByKitLine(candidates.map((c) => c.id));
  let best: { kit: T; cap: number } | null = null;
  for (const c of candidates) {
    const cap = vanReturnableAwayFromHome(movements, c.id, c.warehouseId, vanQty.get(c.id) ?? 0);
    if (cap > 0 && (!best || cap > best.cap)) best = { kit: c, cap };
  }
  return best;
}

// Units of a kit line a PENDING van transfer has already claimed.
//
// A kit line stores a planned quantity and one warehouse; the split ("1 from stock, 2 off a
// colleague's van") lives on the kit REQUEST, not on the line. So `qty - already` — the cap the scan
// used — let a warehouse issue the whole line while a transfer for part of it was in flight, and the
// engineer ended up holding more than the line ever planned.
//
// PENDING only. A completed transfer already writes a movement attributed to the kit line, so it sits
// inside `already` and subtracting it again would double-count. A declined or cancelled one leaves
// this set entirely, which correctly returns the capacity to the warehouse.
async function pendingVanQtyByKitLine(kitLineIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (kitLineIds.length === 0) return out;
  // The empty fallback needs the same type as the real result, or `.catch` widens it to Map<any, any>
  // and the reduce below silently loses its typing.
  type VanSources = Awaited<ReturnType<typeof transferRepo.findVanSourcesByKitLines>>;
  const sources: VanSources = await transferRepo.findVanSourcesByKitLines(kitLineIds).catch(() => new Map() as VanSources);
  for (const [kitLineId, list] of sources) {
    const pending = list.filter((v) => v.status === "pending").reduce((n, v) => n + v.quantity, 0);
    if (pending > 0) out.set(kitLineId, pending);
  }
  return out;
}

export async function scanLookup(input: ScanLookupInput, actor?: AuditActor): Promise<ScanMatch> {
  const job = await jobRepo.findById(input.jobId);
  if (!job) throw notFound("Job not found.");
  const movements = await goodsManagementRepo.findMovementsByJob(job.id);
  const code = input.code.trim();

  // 1) IRM lookup by code/barcode/sku.
  const irmItem = await irmService.findActiveByCodeOrBarcode(code);
  if (irmItem) {
    if (irmItem.trackSerialNumbers || irmItem.trackBatchNumbers) {
      throw conflict(`${irmItem.name} is serial/batch-tracked — those items can't be moved here yet.`);
    }
    // Match the kit line for THIS item AT THIS warehouse — a job can list the same IRM item at more
    // than one warehouse, so picking the first by item id alone would resolve the wrong warehouse.
    let kit = (job.kitLines ?? []).find((k) => k.lineType === "irm" && k.irmItemId === irmItem.id && k.warehouseId === input.warehouseId);
    // When the item isn't homed at the scanning warehouse, a RETURN of its VAN portion may still land
    // here (van stock owes no warehouse). awayCap is that allowance; null ⇒ a normal same-warehouse
    // return, capped by the whole line. Issues are unaffected — you can only issue what's actually held.
    let awayCap: number | null = null;
    if (!kit && input.direction === "return") {
      const away = await findAwayReturnKitLine(
        (job.kitLines ?? []).filter((k) => k.lineType === "irm" && k.irmItemId === irmItem.id),
        movements,
      );
      if (away) { kit = away.kit; awayCap = away.cap; }
    }
    if (!kit) {
      const onJobElsewhere = (job.kitLines ?? []).some((k) => k.lineType === "irm" && k.irmItemId === irmItem.id);
      throw badRequest(onJobElsewhere
        ? `${irmItem.name} is on this job but assigned to a different warehouse — issue it from there.`
        : `${irmItem.name} is not on this job's kit list.`);
    }
    assertWarehouseAccess(actor, input.warehouseId);
    const already = issuedForKitLine(movements, kit.id);
    // Availability is always read at the warehouse being scanned — for a van return that's where the
    // stock is actually landing, not the line's nominal home.
    const bal = await inventoryRepo.findBalancePair(irmItem.id, input.warehouseId);
    const available = (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
    // Return cap, bounded by the engineer's REAL global holding. At the line's HOME warehouse that's
    // the whole line still out (issued − used − returned) — an item issued from two warehouses must
    // only allow back at each what actually left it, else one is over-credited and the other short.
    // Away from home, only the van portion may land (awayCap). The global bound also covers the
    // cross-job case (item handed back under another job → global lower).
    const split = kitLineSplit(movements, kit.id);
    const lineOutstanding = Math.max(0, split.issued - split.used - split.returned);
    const globalHeld = job.assignedEngineerId
      ? (await engineerStockRepo.findEngineerBalance(irmItem.id, job.assignedEngineerId))?.quantityOnHand ?? 0
      : 0;
    const held = Math.min(awayCap ?? lineOutstanding, globalHeld);
    return {
      source: "irm", irmItemId: irmItem.id, jobKitLineId: kit.id, itemName: irmItem.name, uom: irmItem.baseUnit,
      plannedQty: kit.qty, alreadyIssued: already,
      // Minus what a pending van transfer is already bringing — see pendingVanQtyByKitLine.
      remainingIssuable: Math.max(0, kit.qty - already - ((await pendingVanQtyByKitLine([kit.id])).get(kit.id) ?? 0)),
      heldByEngineer: held, available,
    };
  }

  // 2) Rental catalogue lookup by the RNT-#### on the printed label.
  //
  // Sits between IRM and customer stock because the code spaces cannot collide — an IRM scan matches
  // `code`/`barcode`/`sku`, all IRM-owned, and a rental label is only ever `Code128(RentalItem.code)`.
  // Ordering is therefore about cost, not correctness.
  const rentalItem = await rentalItemRepo.findActiveByCode(code);
  if (rentalItem) {
    // Same warehouse rule as IRM: a job may list the same hired model at more than one depot, so the
    // line is matched on item AND warehouse. Unlike IRM there is no van-return widening — hired kit is
    // not transferable between engineers in this phase, so there is no away-from-home leg to allow.
    const kit = (job.kitLines ?? []).find(
      (k) => k.lineType === "rental" && k.rentalItemId === rentalItem.id && k.warehouseId === input.warehouseId,
    );
    if (!kit) {
      const onJobElsewhere = (job.kitLines ?? []).some((k) => k.lineType === "rental" && k.rentalItemId === rentalItem.id);
      throw badRequest(onJobElsewhere
        ? `${rentalItem.name} is on this job but assigned to a different warehouse — issue it from there.`
        : `${rentalItem.name} is not on this job's kit list.`);
    }
    assertWarehouseAccess(actor, input.warehouseId);
    const already = issuedForKitLine(movements, kit.id);
    const split = kitLineSplit(movements, kit.id);
    const lineOutstanding = Math.max(0, split.issued - split.used - split.returned);

    // "Today" in COMPANY time, resolved ONCE for this scan and used by both legs below — never from a
    // client clock. Hire dates are calendar days stored at UTC midnight and startOfDayIn answers
    // "which calendar date is it now" in the same form, so the two compare directly.
    const todayStart = await companyTodayStart();

    // The hires of this item at THIS warehouse, soonest deadline first — and WHICH SET depends on the
    // leg, because the two legs ask opposite questions.
    //
    // Issue: only hires we may still lend (`findIssuableHiresByRentalItems`), so an expired hire is
    // not offered however many units of it are on the shelf.
    //
    // Return: every live hire (`findLiveHiresByRentalItems`), expired ones very much included. An
    // expired hire is exactly what a return needs to bind to, and narrowing this leg would leave
    // overdue kit in a van with nothing to scan it against.
    const hires =
      input.direction === "return"
        ? await poRepo.findLiveHiresByRentalItems([rentalItem.id], [input.warehouseId])
        : await poRepo.findIssuableHiresByRentalItems([rentalItem.id], todayStart, [input.warehouseId]);

    if (input.direction === "return") {
      // A return has to credit the hire the units actually came off, and the movement ledger is the
      // only thing that knows which. Resolve it from what this engineer is still holding rather than
      // from the allocator: allocation answers "which hire should we lend", and a return is the
      // opposite question.
      const held = job.assignedEngineerId
        ? await rentalCustodyRepo.findRentalHoldingsByEngineer(job.assignedEngineerId)
        : [];
      // Soonest deadline first again — returning against the most urgent hire first is what gets it
      // off the overdue badge. An UNDATED holding sorts last, not first: `?? 0` put it at the epoch,
      // so a hire with no deadline snapshot beat every real one and was always the hire picked.
      const forThisItem = held
        .filter((h) => h.rentalItemId === rentalItem.id && h.quantityOnHand > 0)
        .sort((a, b) => (a.hireEndDate?.getTime() ?? Infinity) - (b.hireEndDate?.getTime() ?? Infinity));
      // …but only among the hires DELIVERED HERE. EngineerRentalHolding carries no warehouse (see the
      // model), so this filter is item-only and an engineer can hold the same tester on hires from two
      // depots — an ordinary state, since each was issued against its own kit line. Picking purely by
      // deadline then bound the scan to the OTHER depot's hire, and postReturn refuses exactly that
      // ("that hire belongs to a different warehouse") with no second option to scan. `hires` is
      // already this warehouse's live set, fetched above.
      //
      // The fallback keeps the deliberate no-`orderLive` rule on this leg: kit already in someone's
      // hands has to be able to come back whatever happened to the paperwork, and such a hire may no
      // longer appear in `hires`. Better to bind it and let postReturn adjudicate than to refuse the
      // scan outright.
      const liveHere = new Set(hires.map((h) => h.id));
      const here = forThisItem.filter((h) => liveHere.has(h.purchaseOrderRentalLineId));
      // Every live-here hire is offerable; the fallback deliberately offers exactly ONE. A holding
      // whose hire is not live at this depot may well belong to another one, and postReturn refuses
      // precisely that — so listing the whole set here would stage rows that can only fail on Post,
      // which is worse than the single row that at least stands a chance of being the right one.
      const candidates = here.length > 0 ? here : forThisItem.slice(0, 1);
      const target = candidates[0] ?? null;
      if (!target) throw badRequest(`${rentalItem.name} isn't currently out with this engineer.`);

      // Spend the kit line's outstanding units across those hires, soonest deadline first.
      //
      // Each entry is capped at the hire it names, never at everything the engineer holds of this
      // item: `purchaseOrderRentalLineId` commits a post to exactly one of them, so offering the
      // global figure against one hire let the warehouse type 5 and postReturn then 409'd at 3 with
      // no explanation — the remaining 2 belong to a different PO.
      //
      // And the SUM is capped at the line, which is the other half of the same rule. Two hires
      // holding 3 each against a line that owes 3 must offer 3, not 6; the running budget is what
      // makes a panel free to stage every row it is given without the till refusing the surplus.
      let budget = lineOutstanding;
      const bindable: ScanHire[] = [];
      for (const h of candidates) {
        const qty = Math.min(h.quantityOnHand, budget);
        if (qty <= 0) break; // holdings are already `quantityOnHand > 0`, so this is the budget running out
        budget -= qty;
        bindable.push({
          purchaseOrderRentalLineId: h.purchaseOrderRentalLineId,
          poCode: h.poCode,
          hireEndDate: h.hireEndDate?.toISOString() ?? null,
          // Same `todayStart` as the bound hire below and as the issue leg — one scan cannot straddle
          // two dates, however many hires it reports.
          overdue: h.hireEndDate ? h.hireEndDate.getTime() < todayStart.getTime() : false,
          qty,
        });
      }
      // The head of the list IS the bound hire, so the legacy scalar keeps saying exactly what it
      // always said: what may go back on `purchaseOrderRentalLineId`. Zero when the line has nothing
      // outstanding, which is what `Math.min(lineOutstanding, …)` used to produce.
      const heldOnThisHire = bindable[0]?.qty ?? 0;
      return {
        source: "rental",
        rentalItemId: rentalItem.id,
        purchaseOrderRentalLineId: target.purchaseOrderRentalLineId,
        hire: {
          poCode: target.poCode,
          hireEndDate: target.hireEndDate?.toISOString() ?? null,
          itemName: target.itemName,
          // On a RETURN an overdue hire is not a warning, it is the good news — the kit is coming
          // back. Reported anyway so the panel can say which hire it clears. Judged against the SAME
          // `todayStart` the issue leg uses, so one scan cannot straddle two dates.
          overdue: target.hireEndDate ? target.hireEndDate.getTime() < todayStart.getTime() : false,
        },
        hires: bindable,
        jobKitLineId: kit.id,
        itemName: rentalItem.name,
        uom: rentalItem.baseUnit,
        plannedQty: kit.qty,
        alreadyIssued: already,
        remainingIssuable: 0,
        heldByEngineer: heldOnThisHire,
        available: totalAvailable(hires),
      };
    }

    // `hires` is already narrowed to what may be lent today, so the allocator keeps its existing
    // contract — callers hand it eligible candidates and it does not re-filter — and its
    // earliest-deadline-first ordering now drains the soonest VALID deadline rather than reaching for
    // an expired hire first (which is what it used to do, the expired row sorting ahead of every
    // other by construction).
    const pick = allocateFromHires(hires, 1);
    const target = pick?.[0]?.hire ?? null;
    if (!target) {
      throw conflict(
        `No ${rentalItem.name} is available to issue at this warehouse — every hired unit is already out, has gone back to the provider, or sits on a hire whose period has ended. Extend the hire to use it again.`,
      );
    }

    // WHICH HIRES this line would be drawn from, and how much off each — the issue-leg twin of the
    // return's `hires`, and the answer to the same complaint. Binding one hire per scan meant a line
    // for 12 spread over four orders took four scan→type→Post cycles, each capped at a number the
    // warehouse had to discover by being refused. The line's own need is what gets spread, so the
    // entries sum to at most it.
    //
    // Spread by allocateFromHires — the SAME function postIssue commits through, which is the whole
    // reason that module exists: a preview that allocated differently from the post would show one
    // tester and hand over another. Asking it for no more than the depot can cover keeps its
    // no-partial-allocation rule intact (that rule is about a POST, where quietly issuing 3 of the 5
    // someone asked for would be wrong); a SCAN showing what can go out today is exactly what a
    // partly-issued kit line means.
    const need = Math.max(0, kit.qty - already);
    const spread = allocateFromHires(hires, Math.min(need, totalAvailable(hires))) ?? [];
    return {
      source: "rental",
      rentalItemId: rentalItem.id,
      purchaseOrderRentalLineId: target.id,
      hire: {
        poCode: target.poCode,
        hireEndDate: target.hireEndDate.toISOString(),
        itemName: target.itemName,
        overdue: target.hireEndDate.getTime() < todayStart.getTime(),
      },
      hires: spread.map((a) => ({
        purchaseOrderRentalLineId: a.hire.id,
        poCode: a.hire.poCode,
        hireEndDate: a.hire.hireEndDate.toISOString(),
        overdue: a.hire.hireEndDate.getTime() < todayStart.getTime(),
        qty: a.qty,
        available: hireIssuable(a.hire),
      })),
      jobKitLineId: kit.id,
      itemName: rentalItem.name,
      uom: rentalItem.baseUnit,
      plannedQty: kit.qty,
      alreadyIssued: already,
      // Capped at the hire THIS SCAN BOUND TO, not at the depot's cross-hire pool.
      //
      // `target` is one hire (`allocateFromHires(hires, 1)`) and postIssue commits against that single
      // row, so a ceiling sized by the total let the warehouse type a quantity no ONE hire could
      // cover: three planned against hires of 2 and 1 accepted 3, then 409'd with "those units are no
      // longer available on this hire" — which re-scanning could never clear, because the next scan
      // bound the same hire and offered the same 3. Two hires are two scans, of 2 and of 1, which is
      // what the allocator's no-partial-allocation rule already implies.
      remainingIssuable: Math.min(Math.max(0, kit.qty - already), hireIssuable(target)),
      heldByEngineer: 0,
      // The bound hire's own figure, for the same reason: the panel prints this immediately beside the
      // stepper, so a cross-hire total here would advertise headroom the stepper does not have.
      available: hireIssuable(target),
    };
  }

  // 3) Customer stock entry lookup by barcode.
  const entry = await goodsManagementRepo.findCustomerStockEntryByBarcode(code);
  if (entry) {
    const kit = (job.kitLines ?? []).find((k) => k.lineType === "customer_stock" && k.customerStockEntryId === entry.id && k.warehouseId === input.warehouseId);
    if (!kit) {
      const onJobElsewhere = (job.kitLines ?? []).some((k) => k.lineType === "customer_stock" && k.customerStockEntryId === entry.id);
      throw badRequest(onJobElsewhere
        ? `${entry.itemName} is on this job but assigned to a different warehouse.`
        : `${entry.itemName} is not on this job's kit list.`);
    }
    assertWarehouseAccess(actor, input.warehouseId);
    const already = issuedForKitLine(movements, kit.id);
    // Per-warehouse return cap (see IRM branch): still-out from this line, bounded by global holding.
    const split = kitLineSplit(movements, kit.id);
    const lineOutstanding = Math.max(0, split.issued - split.used - split.returned);
    const globalHeld = job.assignedEngineerId
      ? (await goodsManagementRepo.findCustomerHolding(entry.id, job.assignedEngineerId))?.quantityOnHand ?? 0
      : 0;
    const held = Math.min(lineOutstanding, globalHeld);
    return {
      source: "customer", customerStockEntryId: entry.id, jobKitLineId: kit.id, itemName: entry.itemName, uom: entry.uom,
      plannedQty: kit.qty, alreadyIssued: already,
      // Minus what a pending van transfer is already bringing — see pendingVanQtyByKitLine.
      remainingIssuable: Math.max(0, kit.qty - already - ((await pendingVanQtyByKitLine([kit.id])).get(kit.id) ?? 0)),
      heldByEngineer: held, available: entry.quantity,
    };
  }

  throw notFound(`No item matches "${code}".`);
}

// ── Damage-photo upload ───────────────────────────────────────────────────────────────────────
// Receives a data URI from the WM scan panel, uploads it to Cloudinary, and returns the hosted URL.
// The caller (JobScanPanel) stores this URL in the movement line's damagePhotoUrl field, so no raw
// data URI ever reaches the movement-post endpoint (which validates max 2000 chars — a Cloudinary
// URL is always shorter).

export { warehouseScopeFilter }; // re-export for the queue task

// ── Public shape returned to callers ───────────────────────────────────────────────────────────
export interface PublicMovement {
  id: string;
  code: string;
  jobId: string;
  direction: string;
  status: string;
  engineerId: string;
  engineerName: string;
  warehouseId: string | null;
  lines: {
    source: string;
    irmItemId: string | null;
    customerStockEntryId: string | null;
    itemName: string;
    qty: number;
    condition: string;
    /**
     * THE EVIDENCE, on the way back out.
     *
     * The return scan requires a photograph and a reason before it will accept a damaged unit, writes
     * both to the line — and then no read shape carried them, so the one artefact worth most on the day
     * it was taken could not be looked at afterwards by anybody. A `condition: "damaged"` with nothing
     * behind it is a claim; with the picture and the words it is a record.
     *
     * Null on every good line, and on a damaged line from before this was captured.
     */
    damagePhotoUrl: string | null;
    damageReason: string | null;
  }[];
}

function toPublic(m: goodsManagementRepo.JobStockMovementWithRelations): PublicMovement {
  return {
    id: m.id,
    code: m.code,
    jobId: m.jobId,
    direction: m.direction,
    status: m.status,
    engineerId: m.engineerId,
    engineerName: m.engineerName,
    warehouseId: m.warehouseId,
    lines: m.items.map((l) => ({
      source: l.source,
      irmItemId: l.irmItemId,
      customerStockEntryId: l.customerStockEntryId,
      itemName: l.itemName,
      qty: l.qty,
      condition: l.condition,
      damagePhotoUrl: l.damagePhotoUrl ?? null,
      damageReason: l.damageReason ?? null,
    })),
  };
}

async function loadJobOrThrow(jobId: string) {
  const job = await jobRepo.findById(jobId);
  if (!job) throw notFound("Job not found.");
  if (!job.assignedEngineerId) throw conflict("This job has no assigned engineer.");
  return job;
}

// ── Issue flow: scan-out warehouse → engineer ─────────────────────────────────────────────────
export async function postIssue(jobId: string, input: PostMovementInput, actor?: AuditActor): Promise<PublicMovement> {
  if (input.direction !== "issue") throw badRequest("Wrong direction for issue.");
  const job = await loadJobOrThrow(jobId);
  if (!["accepted", "in_progress"].includes(job.status)) {
    throw conflict("Stock can only be issued for an accepted/in-progress job.");
  }
  const summary = await goodsManagementRepo.getSummary(job.id);
  if (summary?.goodsStatus === "reconciled") throw conflict("This job has already been reconciled and is locked.");
  const movements = await goodsManagementRepo.findMovementsByJob(job.id);
  // ONE date for the whole post, resolved before the resolve loop and reused inside the transaction.
  // A multi-line issue straddling midnight must judge every line against the same calendar day —
  // see companyTodayStart.
  const todayStart = await companyTodayStart();

  // Resolve + validate every line against the kit list BEFORE opening the tx.
  type Resolved = {
    line: (typeof input.lines)[number];
    kit: NonNullable<typeof job.kitLines>[number];
    itemName: string;
    uom: string | null;
    warehouseId: string | null; // null for misc lines (no stock / no warehouse)
    customerId?: string | null;
    customerName?: string | null;
    // Rental only — the hire these units come off, resolved before the transaction opens and
    // re-checked inside it. `hireSnapshot` is what the engineer's holdings row is stamped with.
    // `purchaseOrderId` rides along for the realtime refresh at the end — the ORDER is what a hire
    // pane is addressed by, and re-reading the row after the transaction just to learn it would be a
    // query per line for a fire-and-forget emit.
    hire?: { id: string; purchaseOrderId: string; poCode: string | null; hireEndDate: Date; rentalItemId: string } | null;
  };
  const resolved: Resolved[] = [];
  // The kit line's plan, spent ONCE across the whole request — a RUNNING budget, not a ceiling each
  // line re-reads. Every line used to check its own qty against the same movement snapshot, so two
  // lines of 2 against a line planning 3 both read "3 remaining" and both passed: 4 units issued
  // against a plan of 3, and an engineer holding one nobody ordered. It was unreachable while the panel
  // could only send one line per kit line, and issuing across several hires in one post is exactly what
  // makes it reachable. postReturn has carried the same running budget for the same reason.
  const budgets = new Map<string, { remaining: number; vanReserved: number }>();
  for (const line of input.lines) {
    if (!line.jobKitLineId) throw badRequest("Each issued line must reference a kit line.");
    const kit = (job.kitLines ?? []).find((k) => k.id === line.jobKitLineId);
    if (!kit) throw badRequest("Kit line not found on this job.");
    let budget = budgets.get(kit.id);
    if (!budget) {
      const already = issuedForKitLine(movements, kit.id);
      // The authoritative cap. Reserves what a pending van transfer is bringing, so a warehouse can't
      // hand over units a colleague is already committed to — which would leave the engineer holding
      // more than the line plans for, with nothing downstream objecting.
      const vanReserved = (await pendingVanQtyByKitLine([kit.id])).get(kit.id) ?? 0;
      budget = { remaining: Math.max(0, kit.qty - already - vanReserved), vanReserved };
      budgets.set(kit.id, budget);
    }
    if (line.qty > budget.remaining) {
      throw conflict(
        budget.vanReserved > 0
          ? `${kit.itemName}: only ${budget.remaining} left to issue here — ${budget.vanReserved} of the ${kit.qty} planned are coming from another engineer's van.`
          : `${kit.itemName}: only ${budget.remaining} remaining on the kit list.`,
      );
    }
    budget.remaining -= line.qty;
    if (line.source === "irm") {
      const irm = await irmService.requireActiveIrmItem(line.irmItemId!);
      if (irm.trackSerialNumbers || irm.trackBatchNumbers) {
        throw conflict(`${irm.name} is serial/batch-tracked and can't be moved here.`);
      }
      // The kit line arrived as a CLIENT-SUPPLIED id and nothing above ties it to this item — the same
      // hole the rental arm below closes, and it was open here. A hand-built request could file an IRM
      // movement against a rental (or another item's) kit line: the warehouse check passes, the line's
      // plan budget is spent, and every tally downstream reads it as that OTHER item going out.
      if (kit.lineType !== "irm" || kit.irmItemId !== irm.id) {
        throw badRequest(`${irm.name} isn't the item planned on that kit line.`);
      }
      resolved.push({ line, kit, itemName: irm.name, uom: irm.baseUnit, warehouseId: kit.warehouseId! });
    } else if (line.source === "rental") {
      const item = await rentalItemRepo.findById(line.rentalItemId!);
      if (!item) throw badRequest("Rental item not found.");
      // The kit line is resolved by CLIENT-SUPPLIED id alone (see the top of this loop), so it has to
      // be checked against the source the same way the misc arm below checks its own. Without this a
      // rental issue could be filed against an IRM line of the same job at the same warehouse: the
      // three hire guards underneath all compare the hire to `item` and `kit.warehouseId`, and none of
      // them notices that `kit` is not a rental line at all. The custody write would then be capped by
      // — and reported against — a line that plans a different item entirely.
      if (kit.lineType !== "rental" || kit.rentalItemId !== item.id) {
        throw badRequest(`${item.name} isn't the hired item planned on that kit line.`);
      }
      const hire = await poRepo.findHireStockById(line.purchaseOrderRentalLineId!);
      if (!hire) throw badRequest("That hire no longer exists.");
      // Three ways a client-supplied hire id can be wrong, each with its own message because each has
      // a different fix. The scan resolves all three correctly; these guard a hand-built request and a
      // stale panel whose preview was overtaken.
      if (hire.rentalItemId !== item.id) throw badRequest("That hire is for a different rental item.");
      if (hire.warehouseId !== kit.warehouseId) throw badRequest(`${item.name}: that hire was delivered to a different warehouse.`);
      if (hire.hireStatus !== "on_hire") throw conflict(`${item.name}: that hire isn't live — it hasn't been received yet, or it has already gone back.`);
      // Defence in depth against a hand-built request: the scan only ever offers hires on a live
      // order, but this resolves one by a CLIENT-SUPPLIED id and so cannot rely on that filter.
      // Lending against a cancelled or deleted order strands the units — the supplier-return path
      // loads the order and refuses, so they could never be handed back.
      if (!hire.orderLive) throw conflict(`${item.name}: that hire's purchase order has been cancelled or removed — it can't be issued.`);
      resolved.push({
        line,
        kit,
        itemName: item.name,
        uom: item.baseUnit,
        warehouseId: kit.warehouseId!,
        hire: { id: hire.id, purchaseOrderId: hire.purchaseOrderId, poCode: hire.poCode, hireEndDate: hire.hireEndDate, rentalItemId: hire.rentalItemId },
      });
    } else if (line.source === "customer") {
      const entry = await goodsManagementRepo.findCustomerStockEntryById(line.customerStockEntryId!);
      if (!entry) throw badRequest("Customer stock item not found.");
      // Same identity guard as the IRM and rental arms — see the note there.
      if (kit.lineType !== "customer_stock" || kit.customerStockEntryId !== entry.id) {
        throw badRequest(`${entry.itemName} isn't the item planned on that kit line.`);
      }
      resolved.push({ line, kit, itemName: entry.itemName, uom: entry.uom, warehouseId: entry.warehouseId!, customerId: entry.customerId, customerName: entry.customer?.name ?? null });
    } else {
      // misc — free-text kit line, no stock / no warehouse. Issued by count (handed over), no ledger.
      if (kit.lineType !== "misc") throw badRequest("This kit line isn't a misc item.");
      resolved.push({ line, kit, itemName: kit.itemName, uom: null, warehouseId: null });
    }
    // Real lines can only be issued FROM their own pickup warehouse (admins are unrestricted
    // otherwise). Misc lines have no warehouse and may be issued from any warehouse.
    if (line.source !== "misc") {
      if (kit.warehouseId !== input.warehouseId) {
        throw badRequest(`${kit.itemName} isn't stocked at this warehouse and can't be issued from here.`);
      }
      assertWarehouseAccess(actor, input.warehouseId);
    }
  }

  const warehouseId = input.warehouseId; // the warehouse being managed (always set; misc has no own wh)
  const actorEmail = actor?.email ?? null;
  // derive engineerName from snapshot fields (set at assign-time)
  const engineerName = job.assignedEngineerName ?? "";
  const engineerEmail = job.assignedEngineerEmail ?? null;
  // warehouse snapshot from the first REAL line at this warehouse (misc lines carry no warehouse).
  const realLine = resolved.find((r) => r.line.source !== "misc");
  const warehouseName = realLine?.kit.warehouseName ?? null;
  const warehouseCode = realLine?.kit.warehouseCode ?? null;

  const lines = resolved.map((r) => ({
    source: r.line.source,
    irmItemId: r.line.source === "irm" ? r.line.irmItemId! : null,
    customerStockEntryId: r.line.source === "customer" ? r.line.customerStockEntryId! : null,
    rentalItemId: r.line.source === "rental" ? r.line.rentalItemId! : null,
    purchaseOrderRentalLineId: r.line.source === "rental" ? r.hire!.id : null,
    itemName: r.itemName,
    sku: null,
    uom: r.uom,
    qty: r.line.qty,
    condition: "good",
    jobKitLineId: r.kit.id,
    scannedCode: r.line.scannedCode ?? null,
    damagePhotoUrl: null,
    damageReason: null,
    notes: r.line.notes ?? null,
  }));

  const created = await goodsManagementRepo.createMovementWithCode(
    {
      jobId: job.id,
      direction: "issue",
      engineerId: job.assignedEngineerId!,
      engineerName,
      engineerEmail,
      warehouseId,
      warehouseName,
      warehouseCode,
      status: "posted",
      postedAt: new Date(),
      performedBy: actorEmail,
      createdBy: actorEmail,
    },
    lines,
    async (tx, movementId, code) => {
      for (const r of resolved) {
        if (r.line.source === "irm") {
          const live = await inventoryRepo.findBalancePairTx(tx, r.line.irmItemId!, r.warehouseId!);
          const available = (live?.quantityOnHand ?? 0) - (live?.quantityReserved ?? 0);
          if (r.line.qty > available) {
            throw conflict(`${r.itemName}: only ${available} available — stock changed.`);
          }
          await inventoryService.applyOutbound(tx, {
            irmItemId: r.line.irmItemId!,
            warehouseId: r.warehouseId!,
            quantity: r.line.qty,
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            createdBy: actorEmail,
          });
          const eng = await engineerStockRepo.upsertEngineerBalanceTx(tx, r.line.irmItemId!, job.assignedEngineerId!, r.line.qty);
          await engineerStockRepo.insertEngineerTxnTx(tx, {
            irmItemId: r.line.irmItemId!,
            engineerId: job.assignedEngineerId!,
            quantityDelta: r.line.qty,
            type: "job_issue",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: eng.quantityOnHand,
            createdBy: actorEmail,
          });
        } else if (r.line.source === "rental") {
          // The PAPERWORK re-check, which the quantity guard below cannot make. adjustHireIssuedQtyTx
          // is atomic about how MANY, but it reads only the counters: an order cancelled between the
          // resolve above and this commit still satisfies it. Units lent against a dead order are
          // stranded — the supplier-return path loads the order and refuses, so they could never be
          // handed back. Cheap to ask here; impossible to undo if we don't.
          const liveHire = await poRepo.findHireStockByIdTx(tx, r.hire!.id);
          if (!liveHire || !liveHire.orderLive || liveHire.hireStatus !== "on_hire") {
            throw conflict(`${r.itemName}: that hire is no longer live — its order was cancelled, or it has already gone back. Refresh and scan again.`);
          }
          // The HIRE PERIOD re-check, reported separately from the atomic guard below purely so the
          // message can name the real reason. The authoritative check is the `hireEndDate` clause
          // inside adjustHireIssuedQtyTx's conditional write — this one cannot be relied on alone (it
          // is a read, and the deadline could not move between the two anyway, but a plain 409 saying
          // "stock changed" would send the warehouse hunting for a quantity problem that isn't there).
          if (liveHire.hireEndDate.getTime() < todayStart.getTime()) {
            throw conflict(
              `${r.itemName}: that hire ended ${liveHire.hireEndDate.toISOString().slice(0, 10)} and can no longer be issued to a job. Extend the hire, or return the kit to the provider.`,
            );
          }
          // The availability check and the commitment are ONE conditional write on the hire row — see
          // adjustHireIssuedQtyTx. Two warehouses scanning the last tester at the same instant both
          // read "1 available" before the transaction; only one satisfies the guard, and the other
          // rolls back here rather than lending a unit that does not exist.
          // `todayStart` re-asserts the hire window INSIDE the conditional write, which is what makes a
          // stale tab's post fail rather than succeed against a hire that expired while the tab sat
          // open. The read-side check above cannot do that on its own.
          const ok = await poRepo.adjustHireIssuedQtyTx(tx, r.hire!.id, r.line.qty, todayStart);
          if (!ok) throw conflict(`${r.itemName}: those units are no longer available on this hire — its period may have ended, or the stock changed. Refresh and scan again.`);
          const held = await rentalCustodyRepo.upsertRentalHoldingTx(tx, r.hire!.id, job.assignedEngineerId!, r.line.qty, {
            rentalItemId: r.hire!.rentalItemId,
            itemName: r.itemName,
            poCode: r.hire!.poCode,
            hireEndDate: r.hire!.hireEndDate,
          });
          await rentalCustodyRepo.insertRentalTxnTx(tx, {
            purchaseOrderRentalLineId: r.hire!.id,
            engineerId: job.assignedEngineerId!,
            quantityDelta: r.line.qty,
            type: "job_issue",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: held.quantityOnHand,
            createdBy: actorEmail,
          });
        } else if (r.line.source === "customer") {
          const liveEntry = await goodsManagementRepo.findCustomerStockEntryQtyTx(tx, r.line.customerStockEntryId!);
          if (r.line.qty > (liveEntry?.quantity ?? 0)) {
            throw conflict(`${r.itemName}: only ${liveEntry?.quantity ?? 0} available — customer stock changed.`);
          }
          const entry = await goodsManagementRepo.adjustCustomerStockEntryQtyTx(tx, r.line.customerStockEntryId!, -r.line.qty);
          const hold = await goodsManagementRepo.upsertCustomerHoldingTx(tx, r.line.customerStockEntryId!, job.assignedEngineerId!, r.line.qty, { customerId: entry.customerId, customerName: r.customerName ?? null, itemName: entry.itemName });
          await goodsManagementRepo.insertCustomerHoldingTxnTx(tx, {
            customerStockEntryId: r.line.customerStockEntryId!,
            engineerId: job.assignedEngineerId!,
            quantityDelta: r.line.qty,
            type: "job_issue",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: hold.quantityOnHand,
            createdBy: actorEmail,
          });
        }
      }
      // Determine the correct goodsStatus after this movement: "issued" only when EVERY kit line —
      // including misc — is fully issued; otherwise "partially_issued". Misc lines are issued by
      // count in the panel, so a pending misc item keeps the job "partially_issued" until it's done.
      const allKitLines = job.kitLines ?? [];
      const isFullyIssued =
        allKitLines.length > 0 &&
        allKitLines.every((kl) => {
          // Accumulate issued qty for this kit line from existing movements + ALL qty being posted now.
          // SUM the new lines (not .find) — a single issue request can carry more than one line for the
          // same kit line, and counting only the first would mis-set the status.
          let issued = issuedForKitLine(movements, kl.id);
          for (const r of resolved) if (r.kit.id === kl.id) issued += r.line.qty;
          return issued >= kl.qty;
        });
      await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: isFullyIssued ? "issued" : "partially_issued" });
    },
  );

  audit.record({ actor, action: "goods_management.issued", targetType: "job", targetId: job.id, targetLabel: created.code });

  // Realtime: notify the engineer + all office staff watching the jobs list.
  const issuePayload = { jobId: job.id, movementId: created.id, code: created.code, direction: "issue" };
  emitToUser(job.assignedEngineerId!, "goods:issued", issuePayload);
  // "Issued" is warehouse jargon (the system-side scan-out) — the engineer just
  // needs to know their kit is ready and where to get it.
  notify(job.assignedEngineerId!, { title: "Kit ready to collect", body: `Your kit for ${job.jobNumber} is ready at the warehouse — come and collect it.`, data: { type: "job", jobId: job.id } });
  emitGoodsRoom("goods:updated", issuePayload);
  // The HIRE panes too, when hired kit went out — the mirror of the same call in postReturn, which
  // this leg was simply missing. An issue moves `issuedQuantity` and therefore what the order page,
  // the warehouse's on-hire pane and the deadline badges all show, and none of them were being told.
  // Deduped by ORDER: one post can draw off several hires of the same PO, and that is one refresh.
  const issuedHires = new Map<string, string>();
  for (const r of resolved) if (r.hire) issuedHires.set(r.hire.purchaseOrderId, r.hire.poCode ?? "");
  for (const [poId, poCode] of issuedHires) emitHireUpdated(poId, poCode);

  return toPublic(created);
}

// ── Queue: planned vs available ───────────────────────────────────────────────────────────────

export interface QueueKitLine {
  id: string; // kit line id
  lineType: string;
  irmItemId: string | null;
  rentalItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  /**
   * The string that resolves this line in the goods scan box, or null when the line isn't scannable
   * (misc, or a customer entry with no barcode). Lets the queue offer copy-to-clipboard so a manager
   * can paste straight into an issue/return scan instead of hunting the item up. See `scanCodeFor`.
   */
  scanCode: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  warehouseCode: string | null;
  plannedQty: number;
  issuedQty: number; // GROSS issued (total sent out, before returns)
  usedQty: number; // consumed/used on site (incl. lost write-offs)
  returnedQty: number; // returned to the warehouse
  engineerHeld: number; // engineer's REAL current holding of this item (same balance the return scan
  // checks; shared per item across jobs/warehouses) — caps how much can actually be returned
  available: number; // warehouse pool (no cost/value exposed)
  // How many still-out units of this line came from another engineer's van and so may be RETURNED at
  // any warehouse (no warehouse released them; the return path enforces the same via
  // vanReturnableAwayFromHome). > 0 lets the queue keep the line actionable away from its nominal home
  // instead of greying it out. For a MIXED line this is just the van portion — the warehouse-issued
  // part still owes its home. 0 for an ordinary warehouse-issued line.
  vanReturnableQty: number;
  // Total units of this line handed over from a van (completed transfers). Lets the queue show the
  // source split — "N from stock · M from van" — so a merged line's composition is visible rather
  // than hidden behind one issued total. The warehouse-issued part is issuedQty − vanIssuedQty.
  vanIssuedQty: number;
}

export interface QueueRow {
  jobId: string;
  jobNumber: string;
  jobName: string;
  customerId: string;
  customerName: string | null;
  assignedEngineerId: string | null;
  engineerName: string | null;
  status: string;
  goodsStatus: string; // from JobStockSummary (default not_issued)
  /** When the job was raised — the age anchor for a job that has never had a goods movement. */
  createdAt: Date;
  /**
   * The job's TARGET completion date (the planner's deadline), `null` when none was set — it is an
   * optional field on the job. This is the value the queue's due filter matches, so the screen has to
   * be able to show it: filtering on something never displayed leaves nobody able to tell whether the
   * filter did the right thing. NOT `completedAt`, which is when the engineer actually finished.
   */
  completionDate: Date | null;
  /** How that date reads today, in the COMPANY timezone — see `dueStateOf`. `null` = no date set. */
  dueState: QueueDueState | null;
  /**
   * Last goods movement (JobStockSummary.lastMovementAt), `null` if nothing has ever moved.
   * For a RECONCILED job this is effectively its close-out date, which is what the Closed view shows —
   * without it the date filter would be sorting and narrowing on a value the screen never displays, so
   * nobody could tell whether it had done the right thing.
   */
  lastActivityAt: Date | null;
  kitLines: QueueKitLine[];
}

export interface JobGoodsDetail {
  job: {
    id: string;
    jobNumber: string;
    name: string;
    customerId: string;
    customerName: string | null;
    assignedEngineerId: string | null;
    assignedEngineerName: string | null;
    status: string;
  };
  summary: { goodsStatus: string; workSummary: string | null; lastMovementAt: Date | null } | null;
  movements: PublicMovement[];
  /** Per-kit-line tallies (plan spec key: `lines`). */
  lines: QueueKitLine[];
}

export interface QueuePage {
  rows: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /**
   * The configured overdue window (Settings → Operations). Carried on the queue payload so the tab's
   * "Waiting Nd" badge can colour against the SAME number the Overdue tab and the Inventory Hub count
   * with. Sent rather than hardcoded client-side: a warehouse manager may not hold `settings.view`, so
   * the tab cannot fetch Settings for itself, and a local constant would silently disagree the moment
   * an admin moved the window.
   */
  overdueAfterDays: number;
}

// Queue status filters. "active" = anything still needing work (everything except reconciled); the
// others target one exact goodsStatus. "reconciled" backs the read-only Closed / history view.
export const QUEUE_STATUSES = ["active", "not_issued", "partially_issued", "issued", "awaiting_return", "reconciled"] as const;
export type QueueStatusFilter = (typeof QUEUE_STATUSES)[number];

// Queue ordering.
//   "newest"        — job raised most recently first. The DB's own order, and the historical default.
//   "activity_asc"  — least-recently-touched first: the NEGLECTED work. A job that has never moved
//                     sorts by when it was raised, so a request sitting untouched for six weeks rises
//                     to the top instead of sinking under newer ones. Nothing else surfaces it —
//                     listOverdue is driven by issue MOVEMENTS, so a never-issued job can't appear there.
//   "activity_desc" — most-recently-touched first; the sane default for Closed, where "what did we
//                     finish last?" is the question, not "which job was raised last?".
export const QUEUE_SORTS = ["newest", "activity_asc", "activity_desc"] as const;

// Due-date windows for the ACTIVE queue, read off Job.completionDate.
//
// Deliberately NOT the existing activity window, which those filters look like: activity is when
// stock last MOVED, so a job raised for today with nothing issued has no activity and a "today"
// activity window would hide precisely the work being asked about. Due reads the only date a human
// sets on a job, which is the one that answers "what has to go out today".
export const QUEUE_DUE_FILTERS = ["overdue", "today", "week"] as const;
export type QueueDueFilter = (typeof QUEUE_DUE_FILTERS)[number];

// Resolved from the SERVER's clock, never from anything the client sends. A browser in another
// timezone would otherwise shift what "today" means per user, and two managers looking at the same
// queue would disagree about which jobs are due — the same reason the app never accepts a client
// date for a day-boundary decision. The day itself is the COMPANY timezone's calendar day — see
// startOfDayIn — NOT the UTC one: they name different dates for the first hour of every BST day,
// which is the bug this filter was rewritten to stop reproducing.
export function dueWindow(due: QueueDueFilter, now: Date, timeZone: string): { from?: Date; to?: Date } {
  // Shared with the dashboard's dueBreakdown so the card and this queue can never disagree, and
  // company-wide rather than per-warehouse: a job belongs to no warehouse (only its kit lines do), so
  // the dashboard's own count would have no warehouse timezone to read.
  const startOfToday = startOfDayIn(timeZone, now);
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000 - 1);
  if (due === "overdue") return { to: new Date(startOfToday.getTime() - 1) }; // due before today began
  if (due === "today") return { from: startOfToday, to: endOfToday };
  // "week" is today + the next 6 days INCLUSIVE — a planning horizon, so it deliberately includes
  // today rather than starting tomorrow. It does NOT reach backwards; overdue is its own filter.
  return { from: startOfToday, to: new Date(endOfToday.getTime() + 6 * 24 * 60 * 60 * 1000) };
}

/**
 * How a row's due date reads RIGHT NOW — the badge beside the job number.
 *
 * Derived here rather than in the browser so it is provably the same judgement `dueWindow` makes: the
 * "Past due" filter and the "Past due" badge must never disagree about which day it is. `null` for a
 * job with no completion date, which is also the case the badge exists to expose — such a job is
 * silently excluded by EVERY due filter, so the row has to say the date is missing rather than leave
 * the manager wondering where the job went.
 */
export type QueueDueState = "past_due" | "today" | "upcoming";
export function dueStateOf(completionDate: Date | null, now: Date, timeZone: string): QueueDueState | null {
  if (!completionDate) return null;
  const startOfToday = startOfDayIn(timeZone, now);
  if (completionDate < startOfToday) return "past_due";
  // Same inclusive end-of-day the "today" window uses, so a job the filter calls due today always
  // wears the "Due today" badge and never the "upcoming" one.
  if (completionDate.getTime() < startOfToday.getTime() + 24 * 60 * 60 * 1000) return "today";
  return "upcoming";
}

export type QueueSort = (typeof QUEUE_SORTS)[number];

export interface QueueParams {
  warehouseId: string;
  status?: string; // one of QUEUE_STATUSES; defaults to "active"
  search?: string; // job number / name / customer / engineer (DB-filtered)
  // Window on the job's LAST GOODS ACTIVITY (JobStockSummary.lastMovementAt) — "YYYY-MM-DD" or a full
  // ISO datetime. For a reconciled job that timestamp IS the close-out, which is what makes the Closed
  // view answerable ("what did we finish last month?") instead of an ever-growing scroll. There is no
  // dedicated reconciledAt column, so this is the honest field to filter on — hence the neutral name:
  // it means last activity in EVERY view, not "closed on".
  activityFrom?: string;
  activityTo?: string;
  due?: string; // one of QUEUE_DUE_FILTERS — active queue only
  sort?: string; // one of QUEUE_SORTS; defaults to "newest"
  page?: number;
  pageSize?: number;
}

const DEFAULT_QUEUE_PAGE_SIZE = 20;
const MAX_QUEUE_PAGE_SIZE = 100;

/**
 * The exact string that resolves THIS kit line in the goods scan box, or null if the line can't be
 * scanned at all.
 *
 * Mirrors `scanLookup`, and must keep mirroring it — a value this returns that the scan then rejects
 * is worse than offering nothing, because the warehouse would paste it, get "not on this job's kit
 * list", and distrust the feature:
 *   - irm            → its own `code`. Always present (`code String @unique`, auto-allocated), always
 *                      accepted by the scan, and the ONLY identifier a manager can see: this app
 *                      renders its Code128 label from `code` (generateBarcode), and the queue row, the
 *                      item page and the kit list all display it.
 *   - customer_stock → matched on BARCODE ONLY. There is no code/sku arm for it, so an entry with no
 *                      barcode (a draft, or one never printed) genuinely has nothing scannable.
 *   - misc           → free text with no source record. Never scannable.
 *
 * Deliberately does NOT consider `IrmItem.barcode`. That field is the manufacturer's EAN off the
 * supplier's carton — a different physical label, shown nowhere in this app, and in practice always
 * null (the IRM form has no input for it and irm.validation accepts no such field). Falling back to it
 * could never fire either, since `code` cannot be absent. It would be a branch that never runs handing
 * over a value nobody is looking at.
 *
 * `scanLookup` keeps its own `barcode` arm on purpose — that one lets a physical gun resolve a
 * supplier's EAN if the data ever holds one. Reading a label and choosing what to copy are different
 * questions; narrowing this one does not narrow that one.
 */
export function scanCodeFor(
  line: { lineType: string; customerStockEntryId: string | null },
  irmItem: { code: string } | null | undefined,
  customerBarcodes: Map<string, string | null>,
  rentalItem?: { code: string } | null,
): string | null {
  if (line.lineType === "irm") return irmItem?.code?.trim() || null;
  // A rental item's printed label IS Code128 of its own code, so the code is the scan token. Without
  // this the queue offered no scan chip for a hired line and the warehouse had to go and read the
  // sticker off the case — the one thing the chip exists to save.
  if (line.lineType === "rental") return rentalItem?.code?.trim() || null;
  if (line.lineType === "customer_stock" && line.customerStockEntryId) {
    return customerBarcodes.get(line.customerStockEntryId)?.trim() || null;
  }
  return null;
}

/**
 * The kit line's item name with its own code prefix removed — "IRM-0009 — Fibre Cable" → "Fibre Cable".
 *
 * The stored `itemName` is a SNAPSHOT of what the job form's picker displayed, and that picker labels
 * options `${code} — ${name}` so a planner can tell two similar items apart. Once the goods queue can
 * copy the code on click, repeating it inside the name is just noise in an already-wide column.
 *
 * Anchored to the ITEM'S ACTUAL CODE, never a dash split: item names legitimately contain em dashes
 * ("Single-Mode Fibre Optic Cable — 12-Core G.652D"), so splitting on the separator would amputate
 * half the product name. Anything that doesn't start with this exact code is returned untouched.
 *
 * Display only — the stored snapshot stays as it is. It is deliberately history-safe (it must keep
 * reading the way it did when the job was raised, even after the item is renamed), so it is not the
 * thing to rewrite.
 */
export function stripCodePrefix(itemName: string, code: string | null | undefined): string {
  if (!code) return itemName;
  for (const sep of [" — ", " – ", " - "]) {
    const prefix = `${code}${sep}`;
    if (itemName.startsWith(prefix)) return itemName.slice(prefix.length).trim() || itemName;
  }
  return itemName;
}

// Assemble one QueueKitLine from pre-batched lookups: warehouse availability, the movement split
// (issued/used/returned) and the engineer's real holding. Shared by the queue list and the single-job
// detail so the two views can never drift on how "available"/"held"/the split are computed (the bug the
// detail N+1 fix exposed). Each caller batches the lookups its own way and passes the engineer holding in.
function buildKitLineRow(
  kl: {
    id: string;
    lineType: string;
    irmItemId: string | null;
    customerStockEntryId: string | null;
    itemName: string;
    warehouseId: string | null;
    warehouseName: string | null;
    warehouseCode: string | null;
    qty: number;
    rentalItemId?: string | null;
    // Present on the Prisma row via the job include; declared optional so the single-job detail and
    // the queue can both pass their rows without a cast.
    irmItem?: { code: string } | null;
    rentalItem?: { code: string } | null;
  },
  movements: readonly MovementTally[],
  balByKey: Map<string, Awaited<ReturnType<typeof inventoryRepo.findBalancesByItemsAndWarehouses>>[number]>,
  cseQty: Map<string, number>,
  cseBarcode: Map<string, string | null>,
  engineerHeld: number,
  vanQty: number, // qty on this line handed over from a van (completed transfers only)
  // Free hired units per `${rentalItemId}|${warehouseId}`, summed from that item's LIVE HIRES at the
  // depot. A hire has no stock balance of its own, so this is the rental analogue of balByKey.
  rentalAvailByKey: Map<string, number> = new Map(),
): QueueKitLine {
  let available = 0;
  if (kl.lineType === "irm" && kl.irmItemId && kl.warehouseId) {
    const bal = balByKey.get(`${kl.irmItemId}|${kl.warehouseId}`);
    available = (bal?.quantityOnHand ?? 0) - (bal?.quantityReserved ?? 0);
  } else if (kl.lineType === "rental" && kl.rentalItemId && kl.warehouseId) {
    // Left at 0 before this arm existed, so the queue told the warehouse a hired item was unavailable
    // while sixty units sat on the shelf — and the scan panel, which reads the hires directly, said
    // the opposite. Two screens disagreeing about the same number is worse than either being wrong.
    available = rentalAvailByKey.get(`${kl.rentalItemId}|${kl.warehouseId}`) ?? 0;
  } else if (kl.lineType === "customer_stock" && kl.customerStockEntryId) {
    available = cseQty.get(kl.customerStockEntryId) ?? 0; // qty only — no cost/value exposed
  }
  const split = kitLineSplit(movements, kl.id);
  return {
    id: kl.id,
    lineType: kl.lineType,
    irmItemId: kl.irmItemId,
    rentalItemId: kl.rentalItemId ?? null,
    customerStockEntryId: kl.customerStockEntryId,
    itemName: stripCodePrefix(kl.itemName, kl.irmItem?.code ?? kl.rentalItem?.code),
    scanCode: scanCodeFor(kl, kl.irmItem, cseBarcode, kl.rentalItem),
    warehouseId: kl.warehouseId,
    warehouseName: kl.warehouseName,
    warehouseCode: kl.warehouseCode,
    plannedQty: kl.qty,
    issuedQty: split.issued, // gross issued (the per-item lifecycle status derives the rest)
    usedQty: split.used,
    returnedQty: split.returned,
    engineerHeld,
    available,
    // IRM ONLY. Van-sourced IRM owes no warehouse, so any may receive it — but customer stock has no
    // per-warehouse balance: a CustomerStockEntry IS one location, and a return credits that entry, so
    // there is nowhere for an away-from-home consignment return to land without the record claiming
    // the customer's stock sits at a warehouse that doesn't physically have it. Every path that moves
    // stock already agrees (scanLookup + postReturn do away-returns for irm only, and listQueue's
    // job-level widening is irm-only); this row was the one place that said otherwise, so the queue
    // rendered "Any warehouse ×1" on a consignment line and the scan then refused it.
    vanReturnableQty: kl.lineType === "irm" ? vanReturnableAwayFromHome(movements, kl.id, kl.warehouseId, vanQty) : 0,
    vanIssuedQty: Math.min(vanQty, split.issued), // clamp: a transfer can outlive a since-reduced line
  };
}

// The Goods Management queue for ONE warehouse: candidate jobs (a real line stocked here OR any misc
// line) filtered by goodsStatus + search, then paginated. Reconciled jobs are EXCLUDED from the
// default "active" view (they're done) and surfaced only via status="reconciled" (the read-only
// Closed view). Movements + balances are enriched for the CURRENT PAGE ONLY, in batched queries — so
// the endpoint stays ~5 round-trips regardless of how many jobs exist (was an N+1 of 600+).
export async function listQueue(params: QueueParams, actor?: AuditActor): Promise<QueuePage> {
  assertWarehouseAccess(actor, params.warehouseId);
  const status = params.status ?? "active";
  if (!QUEUE_STATUSES.includes(status as QueueStatusFilter)) throw badRequest(`Invalid status filter "${status}".`);
  const sort = (params.sort ?? "newest") as QueueSort;
  if (!QUEUE_SORTS.includes(sort)) throw badRequest(`Invalid sort "${params.sort}".`);
  const pageSize = Math.min(Math.max(Math.trunc(params.pageSize ?? DEFAULT_QUEUE_PAGE_SIZE), 1), MAX_QUEUE_PAGE_SIZE);
  const search = params.search?.trim() || undefined;

  // 1) Candidate jobs for this warehouse, DB-filtered by job status + search, newest first. The query
  // also widens to jobs holding van-sourced stock (JobKitLine.hasVanSource) — that owes no warehouse
  // and is returnable at ANY of them, so a van return must be findable here even though its kit line
  // is homed elsewhere. Widening adds candidates, not noise: step 2c keeps such a job only while it
  // still has van stock out here.
  const jobs = await jobRepo.findActiveForGoodsManagement(params.warehouseId, search);

  // 2) goodsStatus per job (one batched query) → active / closed / exact-status filter.
  const summaries = await goodsManagementRepo.getSummariesByJobs(jobs.map((j) => j.id));
  const statusByJob = new Map(summaries.map((s) => [s.jobId, s.goodsStatus]));
  const goodsStatusOf = (jobId: string) => statusByJob.get(jobId) ?? "not_issued";
  const matchesStatus = (gs: string) => (status === "active" ? gs !== "reconciled" : gs === status);

  // 2a) Optional last-activity window. Applied HERE, from the summaries already loaded, rather than
  // pushed into the job query: the timestamp lives on JobStockSummary, not Job. A job with no summary
  // (or no movement yet) has no activity at all, so it can't fall inside any window — excluded rather
  // than passed through, otherwise "reconciled in July" would also hand back never-touched jobs.
  const activityFrom = parseFilterDate(params.activityFrom, "start");
  const activityTo = parseFilterDate(params.activityTo, "end");
  const activityByJob = new Map(summaries.map((s) => [s.jobId, s.lastMovementAt]));
  const inActivityWindow = (jobId: string) => {
    if (!activityFrom && !activityTo) return true;
    const at = activityByJob.get(jobId);
    if (!at) return false;
    if (activityFrom && at < activityFrom) return false;
    if (activityTo && at > activityTo) return false;
    return true;
  };

  // 2b) Optional DUE window on the job's own completionDate — "what has to go out today", which the
  // activity window above cannot answer (a job with nothing issued yet has no activity at all). A job
  // with no completion date can't fall inside any window, so it is excluded rather than passed
  // through, exactly as an activity-less job is.
  const due = params.due?.trim() || undefined;
  if (due && !QUEUE_DUE_FILTERS.includes(due as QueueDueFilter)) throw badRequest(`Invalid due filter "${due}".`);
  // Resolved ONCE and reused for both the filter window and each row's `dueState`, so the badge the
  // manager reads and the filter that selected the row are computed from the same instant in the same
  // timezone. Deriving the badge in the browser instead would let a client clock or a non-UK laptop
  // disagree with the server about which day it is — the row would sit under "Past due" without
  // looking past due. Same reason the day boundary never comes from the client anywhere else.
  const nowForDue = new Date();
  const dueTimeZone = await getCompanyTimezone();
  const dueRange = due ? dueWindow(due as QueueDueFilter, nowForDue, dueTimeZone) : null;
  const inDueWindow = (j: { completionDate: Date | null }) => {
    if (!dueRange) return true;
    if (!j.completionDate) return false;
    if (dueRange.from && j.completionDate < dueRange.from) return false;
    if (dueRange.to && j.completionDate > dueRange.to) return false;
    return true;
  };

  // A cancelled job belongs here ONLY while its kit is still out — that is the whole reason the
  // candidate query now reaches past `completed`. One that never had stock issued has nothing to scan
  // back, so it would be permanent noise on every warehouse's tab. (Issuing stays blocked either way:
  // postIssue accepts accepted/in_progress only.)
  const isActionable = (j: (typeof jobs)[number]) => j.status !== "cancelled" || goodsStatusOf(j.id) !== "not_issued";
  const byStatus = jobs.filter((j) => isActionable(j) && matchesStatus(goodsStatusOf(j.id)) && inActivityWindow(j.id) && inDueWindow(j));

  // 2b) Drop jobs the DB matched ONLY through the warehouse-blind misc arm of the kit-line filter
  // (see jobRepo.findActiveForGoodsManagement) once that misc work is finished. A misc line carries
  // no warehouseId, so it pulls its job into EVERY warehouse's queue — right while the item is still
  // outstanding (any warehouse may hand it over), but pure noise afterwards: every line then renders
  // greyed out, nothing can be issued or returned here, and the job still inflates "Total: N jobs".
  //
  // This MUST be decided per LINE, not from the job-level goodsStatus: a job sitting at
  // "partially_issued" because a real line at ANOTHER warehouse is short has no work here at all,
  // yet the job-level status can't tell which line type is pending. So we pull issued-per-kit-line
  // for the status-matched candidates in ONE lean query (no relation includes) and mirror exactly
  // what the UI calls actionable — a real line at this warehouse, or a misc line not yet fully
  // issued (GoodsManagementTab: `active = isMisc ? !miscDone : atWh`). Running it here, BEFORE
  // pagination, is what keeps page counts and "Total: N jobs" honest.
  const issuedByLine = await goodsManagementRepo.findIssuedQtyByKitLine(byStatus.map((j) => j.id));
  const hasWorkHere = (j: (typeof jobs)[number]) =>
    (j.kitLines ?? []).some((kl) =>
      kl.lineType === "misc"
        ? (issuedByLine.get(kl.id) ?? 0) < kl.qty
        : kl.warehouseId === params.warehouseId,
    );

  // 2c) A job pulled in ONLY by the van widening (no line here, no pending misc) stays only if it
  // still has van stock returnable away from home — else it's a done job with nothing to do here, and
  // showing it would be the every-warehouse noise we avoid. Precise per-line check; movements load
  // ONLY for this subset (active van jobs not homed here), bounded well below the whole candidate set.
  const maybeVanOnly = byStatus.filter((j) => !hasWorkHere(j));
  const vanReturnableJobs = new Set<string>();
  if (maybeVanOnly.length > 0) {
    const movesByJob = new Map<string, Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJobs>>>();
    for (const m of await goodsManagementRepo.findMovementsByJobs(maybeVanOnly.map((j) => j.id))) {
      (movesByJob.get(m.jobId) ?? movesByJob.set(m.jobId, []).get(m.jobId)!).push(m);
    }
    const vanQtyByLine = await completedVanQtyByKitLine(maybeVanOnly.flatMap((j) => (j.kitLines ?? []).map((k) => k.id)));
    for (const j of maybeVanOnly) {
      const has = (j.kitLines ?? []).some(
        (k) => k.lineType === "irm" && vanReturnableAwayFromHome(movesByJob.get(j.id) ?? [], k.id, k.warehouseId, vanQtyByLine.get(k.id) ?? 0) > 0,
      );
      if (has) vanReturnableJobs.add(j.id);
    }
  }

  const filtered = byStatus.filter((j) => hasWorkHere(j) || vanReturnableJobs.has(j.id));

  // 3) Order, then paginate. "newest" keeps the query's own createdAt-desc order; the activity sorts
  // re-order the whole candidate set — correct only because it is already in memory here, and
  // necessarily BEFORE the slice, or "longest waiting" would just re-shuffle whichever page you were
  // looking at. A job that has never moved sorts by when it was raised, so it ages like any other
  // rather than pinning to one end. Array.sort is stable, so ties keep the DB's order.
  const ageKey = (j: (typeof jobs)[number]) => (activityByJob.get(j.id) ?? j.createdAt).getTime();
  const ordered =
    sort === "activity_asc"
      ? [...filtered].sort((a, b) => ageKey(a) - ageKey(b))
      : sort === "activity_desc"
        ? [...filtered].sort((a, b) => ageKey(b) - ageKey(a))
        : filtered;

  const total = ordered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(params.page ?? 1), 1), totalPages);
  const pageJobs = ordered.slice((page - 1) * pageSize, page * pageSize);

  // 4) Enrich ONLY the page, in batched queries (movements grouped by job; IRM balances; customer qty).
  const movementsByJob = new Map<string, Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJobs>>>();
  for (const m of await goodsManagementRepo.findMovementsByJobs(pageJobs.map((j) => j.id))) {
    const list = movementsByJob.get(m.jobId);
    if (list) list.push(m);
    else movementsByJob.set(m.jobId, [m]);
  }
  const irmItemIds = new Set<string>();
  const whIds = new Set<string>();
  const cseIds = new Set<string>();
  const rentalItemIds = new Set<string>();
  for (const j of pageJobs) {
    for (const kl of j.kitLines ?? []) {
      if (kl.lineType === "irm" && kl.irmItemId && kl.warehouseId) {
        irmItemIds.add(kl.irmItemId);
        whIds.add(kl.warehouseId);
      } else if (kl.lineType === "rental" && kl.rentalItemId && kl.warehouseId) {
        rentalItemIds.add(kl.rentalItemId);
        whIds.add(kl.warehouseId);
      } else if (kl.lineType === "customer_stock" && kl.customerStockEntryId) {
        cseIds.add(kl.customerStockEntryId);
      }
    }
  }
  const balByKey = new Map(
    (await inventoryRepo.findBalancesByItemsAndWarehouses([...irmItemIds], [...whIds])).map((b) => [`${b.irmItemId}|${b.warehouseId}`, b]),
  );
  const rentalAvailByKey = await rentalPoolByItemAndWarehouse([...rentalItemIds], [...whIds], await companyTodayStart());
  // One query, two lookups: quantity for the Available column, barcode for the scan-code chip.
  const cseRows = await goodsManagementRepo.findCustomerStockEntriesByIds([...cseIds]);
  const cseQty = new Map(cseRows.map((e) => [e.id, e.quantity]));
  const cseBarcode = new Map(cseRows.map((e) => [e.id, e.barcode]));

  // Engineer's REAL holding per item (same balance the return scan checks) — keyed by
  // `${engineerId}|${itemId}`. The holding is global per item (shared across jobs/warehouses), so this
  // is the only honest source for "to return": it can never claim more than the engineer actually has.
  //
  // TWO queries for the whole page, not two PER ENGINEER. This looped over engineers on the belief
  // that a page only has a handful — but the page size is 20, so a busy queue meant 40 sequential
  // round trips (~3s on a remote cluster) to build one lookup map. The engineer id now rides in the
  // rows, and the two reads run together.
  const pageEngineerIds = [...new Set(pageJobs.map((j) => j.assignedEngineerId).filter((id): id is string => !!id))];
  const engHeld = new Map<string, number>();
  const [engBalances, engCustomerHoldings] = await Promise.all([
    engineerStockRepo.findBalanceQuantitiesByEngineers(pageEngineerIds),
    goodsManagementRepo.findCustomerHoldingQuantitiesByEngineers(pageEngineerIds),
  ]);
  for (const b of engBalances) engHeld.set(`${b.engineerId}|${b.irmItemId}`, b.quantityOnHand);
  for (const h of engCustomerHoldings) engHeld.set(`${h.engineerId}|${h.customerStockEntryId}`, h.quantityOnHand);
  // Hired custody is stored per HIRE; the queue asks per catalogue item, so it is summed on the way in
  // — the same reduction rentalHeldByItem does for the single-job path.
  for (const r of await rentalCustodyRepo.findRentalHoldingQuantitiesByEngineers(pageEngineerIds)) {
    if (!r.rentalItemId) continue;
    const key = `${r.engineerId}|${r.rentalItemId}`;
    engHeld.set(key, (engHeld.get(key) ?? 0) + r.quantityOnHand);
  }

  // Van-supplied qty per kit line for the PAGE (one lean query) — decides which lines stay actionable
  // away from their nominal home warehouse.
  const vanQtyByLine = await completedVanQtyByKitLine(pageJobs.flatMap((j) => (j.kitLines ?? []).map((k) => k.id)));

  const rows: QueueRow[] = pageJobs.map((job) => {
    const movements = movementsByJob.get(job.id) ?? [];
    const heldOf = (kl: { irmItemId: string | null; rentalItemId?: string | null; customerStockEntryId: string | null }) => {
      if (!job.assignedEngineerId) return 0;
      // Rental sits between the other two: without it a hired line reported "held 0", so the return
      // scan offered nothing to hand back on a line the engineer was demonstrably carrying.
      const itemId = kl.irmItemId ?? kl.rentalItemId ?? kl.customerStockEntryId;
      return itemId ? engHeld.get(`${job.assignedEngineerId}|${itemId}`) ?? 0 : 0;
    };
    const kitLines: QueueKitLine[] = (job.kitLines ?? []).map((kl) => buildKitLineRow(kl, movements, balByKey, cseQty, cseBarcode, heldOf(kl), vanQtyByLine.get(kl.id) ?? 0, rentalAvailByKey));
    return {
      jobId: job.id,
      jobNumber: job.jobNumber,
      jobName: job.name,
      customerId: job.customerId,
      customerName: job.customerName,
      assignedEngineerId: job.assignedEngineerId,
      // Prefer the assign-time snapshot; fall back to the live engineer relation so the queue still
      // shows a name for jobs assigned before the snapshot was populated.
      engineerName:
        job.assignedEngineerName ??
        (job.assignedEngineer ? `${job.assignedEngineer.firstName} ${job.assignedEngineer.lastName}`.trim() : null),
      status: job.status,
      goodsStatus: goodsStatusOf(job.id),
      createdAt: job.createdAt,
      completionDate: job.completionDate ?? null,
      dueState: dueStateOf(job.completionDate ?? null, nowForDue, dueTimeZone),
      lastActivityAt: activityByJob.get(job.id) ?? null,
      kitLines,
    };
  });

  return { rows, total, page, pageSize, totalPages, overdueAfterDays: await getOverdueAfterDays() };
}

export async function getJobGoods(jobId: string, actor?: AuditActor): Promise<JobGoodsDetail> {
  const job = await jobRepo.findById(jobId);
  if (!job) throw notFound("Job not found.");

  const movements = await goodsManagementRepo.findMovementsByJob(job.id);
  const summary = await goodsManagementRepo.getSummary(job.id);

  // Enforce per-line warehouse access before any enrichment.
  for (const kl of job.kitLines ?? []) {
    if (kl.warehouseId) assertWarehouseAccess(actor, kl.warehouseId);
  }

  // Enrich in batched queries (was an N+1 of ~3 round-trips per kit line) — same approach as listQueue.
  const irmItemIds = new Set<string>();
  const whIds = new Set<string>();
  const cseIds = new Set<string>();
  const rentalItemIds = new Set<string>();
  for (const kl of job.kitLines ?? []) {
    if (kl.lineType === "irm" && kl.irmItemId && kl.warehouseId) {
      irmItemIds.add(kl.irmItemId);
      whIds.add(kl.warehouseId);
    } else if (kl.lineType === "rental" && kl.rentalItemId && kl.warehouseId) {
      rentalItemIds.add(kl.rentalItemId);
      whIds.add(kl.warehouseId);
    } else if (kl.lineType === "customer_stock" && kl.customerStockEntryId) {
      cseIds.add(kl.customerStockEntryId);
    }
  }
  const balByKey = new Map(
    (await inventoryRepo.findBalancesByItemsAndWarehouses([...irmItemIds], [...whIds])).map((b) => [`${b.irmItemId}|${b.warehouseId}`, b]),
  );
  const rentalAvailByKey = await rentalPoolByItemAndWarehouse([...rentalItemIds], [...whIds], await companyTodayStart());
  // One query, two lookups: quantity for the Available column, barcode for the scan-code chip.
  const cseRows = await goodsManagementRepo.findCustomerStockEntriesByIds([...cseIds]);
  const cseQty = new Map(cseRows.map((e) => [e.id, e.quantity]));
  const cseBarcode = new Map(cseRows.map((e) => [e.id, e.barcode]));
  // Engineer's REAL holding per item (global per item) — batched once for the job's single engineer.
  const engHeld = new Map<string, number>();
  if (job.assignedEngineerId) {
    for (const b of await engineerStockRepo.findEngineerBalances(job.assignedEngineerId)) engHeld.set(b.irmItemId, b.quantityOnHand);
    for (const h of await goodsManagementRepo.findCustomerHoldingsByEngineer(job.assignedEngineerId)) engHeld.set(h.customerStockEntryId, h.quantityOnHand);
    for (const [rentalItemId, h] of await rentalHeldByItem(job.assignedEngineerId)) engHeld.set(rentalItemId, h.qty);
  }

  const heldOf = (kl: { irmItemId: string | null; rentalItemId?: string | null; customerStockEntryId: string | null }) => {
    if (!job.assignedEngineerId) return 0;
    const itemId = kl.irmItemId ?? kl.rentalItemId ?? kl.customerStockEntryId;
    return itemId ? engHeld.get(itemId) ?? 0 : 0;
  };
  const vanQtyByLine = await completedVanQtyByKitLine((job.kitLines ?? []).map((k) => k.id));
  const lines: QueueKitLine[] = (job.kitLines ?? []).map((kl) => buildKitLineRow(kl, movements, balByKey, cseQty, cseBarcode, heldOf(kl), vanQtyByLine.get(kl.id) ?? 0, rentalAvailByKey));

  return {
    job: {
      id: job.id,
      jobNumber: job.jobNumber,
      name: job.name,
      customerId: job.customerId,
      customerName: job.customerName,
      assignedEngineerId: job.assignedEngineerId,
      assignedEngineerName: job.assignedEngineerName,
      status: job.status,
    },
    summary: summary
      ? { goodsStatus: summary.goodsStatus, workSummary: summary.workSummary, lastMovementAt: summary.lastMovementAt }
      : null,
    movements: movements.map(toPublic),
    lines,
  };
}

// ── Return flow: scan-in engineer → warehouse (good) or damaged pool (damaged) ──────────────
export async function postReturn(jobId: string, input: PostMovementInput, actor?: AuditActor): Promise<PublicMovement> {
  if (input.direction !== "return") throw badRequest("Wrong direction for return.");
  const job = await loadJobOrThrow(jobId);
  // `cancelled` belongs here. It is reachable from accepted/in_progress, so the engineer is usually
  // still holding the kit when it lands — and a cancelled job can never become `completed`, so it can
  // never reach awaiting_return through the engineer, which is the only door closeReconcile opens
  // from. Leaving it out made a cancelled job's stock unreturnable AND unwriteable-off: it sat on the
  // overdue chase list permanently with no action that could clear it. See openReturnsOnCancel.
  if (!["accepted", "in_progress", "completed", "cancelled"].includes(job.status)) {
    throw conflict("Stock can only be returned for an accepted/in-progress/completed job.");
  }
  const returnSummary = await goodsManagementRepo.getSummary(job.id);
  if (returnSummary?.goodsStatus === "reconciled") throw conflict("This job has already been reconciled and is locked.");
  const actorEmail = actor?.email ?? null;

  // Fetched at most ONCE per call and shared by the van-source check below and the outstanding-qty
  // budget further down (which already needed them) — so allowing van returns costs no extra query.
  let movementsCache: Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJob>> | null = null;
  const loadMovements = async () => (movementsCache ??= await goodsManagementRepo.findMovementsByJob(job.id));

  // Resolve line details + warehouse for the movement header (derived from kit lines).
  // For returns we derive item names + warehouse from the kit list (already on the job), not by
  // re-fetching the IRM item or CSE — this keeps the pre-validation fast and test-friendly.
  type Resolved = {
    line: (typeof input.lines)[number];
    itemName: string;
    uom: string | null;
    sku: string | null;
    warehouseId: string;
    warehouseName: string | null;
    warehouseCode: string | null;
    customerId: string | null;
    condition: "good" | "damaged";
    awayReturn?: boolean; // van portion returned away from the kit line's home warehouse
    kitHomeWarehouseId?: string | null; // the kit line's own home (sizes the away-from-home budget)
    hireId?: string | null; // rental only — the hire being credited back
    hirePurchaseOrderId?: string | null;
    hirePoCode?: string | null;
    hireWarehouseId?: string | null;
    // The kit line THE SERVER matched — what the movement is filed against AND what its per-line
    // return budget is charged to. Both, or neither: the client also sends a jobKitLineId and
    // validation requires one, but presence is not consistency. A well-formed id naming a DIFFERENT
    // line of this job passes validation, and filing the movement against one line while charging the
    // cap to another means a return can be credited twice — once to each line's budget. postIssue
    // writes its own resolved id for exactly this reason; every arm below now does the same.
    kitLineId?: string;
  };
  // The one id both the ledger row and the budget below may use. Nothing downstream may reach past
  // this to `line.jobKitLineId` — that is the client's claim, and the two diverging is the bug.
  const kitLineIdOf = (r: Resolved): string | null => r.kitLineId ?? r.line.jobKitLineId ?? null;
  // Hires that already carry a damaged line in THIS request — see the guard in the rental arm below.
  const damagedHires = new Set<string>();
  const resolved: Resolved[] = [];

  for (const line of input.lines) {
    const condition = (line.condition ?? "good") as "good" | "damaged";
    if (line.source === "irm") {
      if (!line.irmItemId) throw badRequest("IRM return line is missing irmItemId.");
      // Match the kit line for this item AT THIS warehouse (an item may be listed at several).
      let kit = (job.kitLines ?? []).find((k) => k.lineType === "irm" && k.irmItemId === line.irmItemId && k.warehouseId === input.warehouseId);
      // Mirror scanLookup: the VAN portion of a line owes no warehouse, so it can be scanned back in
      // anywhere. Must be enforced HERE too — scanLookup only feeds the UI, and this is the call that
      // actually moves stock. `awayReturn` flags it so the per-warehouse budget below caps at the van
      // portion (not the whole line) and the movement is credited to the receiving warehouse.
      const awayReturn = !kit;
      // The per-line van cap below is keyed by jobKitLineId. Without it an away return skips the cap
      // entirely (bounded only by physical holding), so it could over-credit the receiving warehouse
      // while leaving the line's home warehouse permanently short. scanLookup always supplies the line
      // id, so require it here rather than letting the capacity-based fallback size an uncapped return.
      if (awayReturn && !line.jobKitLineId) throw badRequest("An away-from-home return must reference its kit line.");
      if (!kit) {
        // Resolve the EXACT kit line the client scanned (its id came from scanLookup), NOT a fresh
        // capacity-based re-pick. When the same item is homed at two warehouses, re-picking could land
        // on the other line if caps shifted between scan and post, then size THIS return's budget with
        // that line's home — miscounting home-vs-away returns and wrongly rejecting. The scanned line
        // keeps scan and post consistent. Falls back to the capacity pick only if no line id was sent.
        kit = line.jobKitLineId
          ? (job.kitLines ?? []).find((k) => k.lineType === "irm" && k.id === line.jobKitLineId && k.irmItemId === line.irmItemId && !!k.warehouseId && k.warehouseId !== input.warehouseId)
          : undefined;
        if (!kit) {
          const away = await findAwayReturnKitLine(
            (job.kitLines ?? []).filter((k) => k.lineType === "irm" && k.irmItemId === line.irmItemId),
            await loadMovements(),
          );
          kit = away?.kit;
        }
      }
      if (!kit?.warehouseId) throw badRequest("Cannot determine warehouse for this IRM return line.");
      assertWarehouseAccess(actor, input.warehouseId);
      resolved.push({
        line, itemName: kit.itemName, uom: null, sku: null,
        // Credit the warehouse that physically received it — for a van return that's the scanning
        // warehouse, not the line's nominal home (which never held this stock).
        warehouseId: awayReturn ? input.warehouseId : kit.warehouseId,
        warehouseName: awayReturn ? null : kit.warehouseName ?? null,
        warehouseCode: awayReturn ? null : kit.warehouseCode ?? null,
        customerId: null, condition,
        awayReturn,
        // The resolved line's own home — sizes the away-from-home budget (counts returns made at any
        // warehouse other than this). Same as input.warehouseId for a home return.
        kitHomeWarehouseId: kit.warehouseId,
        // Server-resolved, like the rental arm. `kit` is matched on item + warehouse, and job
        // validation makes that pair unique per job, so this is the only line the return CAN belong
        // to — whatever id the client sent alongside it.
        kitLineId: kit.id,
      });
    } else if (line.source === "rental") {
      if (!line.rentalItemId) throw badRequest("Rental return line is missing rentalItemId.");
      if (!line.purchaseOrderRentalLineId) throw badRequest("Rental return line is missing the hire it came from.");
      // Hired kit goes back where it was collected. There is no away-from-home leg: a hire is not
      // transferable between engineers in this phase, so nothing can arrive at a warehouse that did
      // not lend it, and the hire's own delivery warehouse is the one the provider will collect from.
      const kit = (job.kitLines ?? []).find(
        (k) => k.lineType === "rental" && k.rentalItemId === line.rentalItemId && k.warehouseId === input.warehouseId,
      );
      if (!kit?.warehouseId) {
        // Name the item, and say WHICH of the two things is wrong — the same pair scanLookup
        // distinguishes on the way in. "That hired item isn't on this job's kit list at this
        // warehouse" was one sentence for two different problems, on a panel that may hold several
        // hires, and it named none of them.
        const onJobElsewhere = (job.kitLines ?? []).find((k) => k.lineType === "rental" && k.rentalItemId === line.rentalItemId);
        // Not on the job at all ⇒ there is no kit-line snapshot to read the name from, so look it up.
        // One extra query on an error path, to avoid the "that hired item" that started this.
        const named = onJobElsewhere?.itemName ?? (await rentalItemRepo.findById(line.rentalItemId))?.name;
        throw badRequest(
          onJobElsewhere
            ? `${named} is on this job but was collected from a different warehouse — return it there.`
            : `${named ?? "That hired item"} isn't on this job's kit list.`,
        );
      }
      const hire = await poRepo.findHireStockById(line.purchaseOrderRentalLineId);
      if (!hire) throw badRequest("That hire no longer exists.");
      // The hire id is CLIENT-SUPPLIED, and `kit` above was matched on the ITEM — so nothing yet ties
      // the two together. postIssue guards identity on both axes (item and warehouse); this leg
      // guarded only the warehouse, which let an engineer holding two different hired items at one
      // depot have the WRONG hire's custody drained and its units released back to the provider's
      // count. The `orderLive` guard stays deliberately absent here (see the note below) — identity
      // does not: getting the paperwork wrong is not the same as the paperwork having moved on.
      if (hire.rentalItemId !== line.rentalItemId) {
        throw badRequest(`${kit.itemName}: that hire is for a different rental item.`);
      }
      if (hire.warehouseId !== kit.warehouseId) throw badRequest(`${kit.itemName}: that hire belongs to a different warehouse.`);
      // ONE damaged line per hire per movement, enforced here instead of assumed.
      //
      // A damaged return opens a custody exit keyed [sourceType, sourceId, hire, kind] with the
      // MOVEMENT as sourceId, so a second damaged line on the same hire collides — and createExitTx
      // reads a collision as an idempotent retry and hands back the first row. The second line's units
      // would still be drained from custody and released to the shelf by adjustHireIssuedQtyTx, with no
      // exit holding them down: a damaged tester quietly becomes issuable to the next job.
      //
      // The panel makes one card per hire so it cannot send this, but that made the invariant the
      // CLIENT's to keep, and posts carrying several hires at once are new. Refusing is right rather
      // than merging: two damage reports are two reasons and two photographs, and picking one of each
      // to keep is not a decision this layer can make.
      if (condition === "damaged" && damagedHires.has(hire.id)) {
        throw badRequest(`${kit.itemName}: only one damaged line per hire in a single return — combine them into one line with the qty and a single reason.`);
      }
      if (condition === "damaged") damagedHires.add(hire.id);
      // NOTE: no `orderLive` guard on the RETURN leg, deliberately. Kit already in an engineer's hands
      // has to be able to come back whatever happened to the paperwork behind it — refusing here would
      // strand it in the van with no way to record its return.
      assertWarehouseAccess(actor, input.warehouseId);
      resolved.push({
        line, itemName: kit.itemName, uom: null, sku: null, warehouseId: kit.warehouseId,
        warehouseName: kit.warehouseName ?? null, warehouseCode: kit.warehouseCode ?? null,
        customerId: null, condition,
        hireId: hire.id,
        // Carried off the same resolved hire so the damage arm below does not re-read the row it
        // already has. A custody exit is filed against the ORDER's depot, not the scanning one.
        hirePurchaseOrderId: hire.purchaseOrderId,
        hirePoCode: hire.poCode,
        hireWarehouseId: hire.warehouseId,
        kitHomeWarehouseId: kit.warehouseId,
        kitLineId: kit.id,
      });
    } else {
      if (!line.customerStockEntryId) throw badRequest("Customer return line is missing customerStockEntryId.");
      // Derive warehouse + item name from the kit line (at THIS warehouse). Fall back to CSE fetch.
      const kit = (job.kitLines ?? []).find((k) => k.lineType === "customer_stock" && k.customerStockEntryId === line.customerStockEntryId && k.warehouseId === input.warehouseId);
      if (kit?.warehouseId) {
        assertWarehouseAccess(actor, input.warehouseId);
        resolved.push({
          line, itemName: kit.itemName, uom: null, sku: null, warehouseId: kit.warehouseId,
          warehouseName: kit.warehouseName ?? null, warehouseCode: kit.warehouseCode ?? null,
          customerId: null, condition,
        });
      } else {
        // Kit line absent or has no warehouseId — fall back to live CSE lookup.
        const entry = await goodsManagementRepo.findCustomerStockEntryById(line.customerStockEntryId);
        if (!entry) throw badRequest("Customer stock item not found.");
        if (!entry.warehouseId) throw badRequest("Cannot determine warehouse for this customer return line.");
        assertWarehouseAccess(actor, entry.warehouseId);
        resolved.push({
          line, itemName: entry.itemName, uom: entry.uom ?? null, sku: null, warehouseId: entry.warehouseId,
          warehouseName: null, warehouseCode: null,
          customerId: entry.customerId ?? null, condition,
        });
      }
    }
  }

  // Every return line must belong to THIS warehouse — can't receive another warehouse's items here.
  for (const r of resolved) {
    if (r.warehouseId !== input.warehouseId) {
      throw badRequest(`${r.itemName} isn't stocked at this warehouse and can't be received here.`);
    }
  }

  const warehouseId = resolved[0].warehouseId;
  // Van-sourced lines carry no warehouse snapshot (their kit line is homed elsewhere, and naming
  // THAT warehouse on a movement received here would be wrong). Every resolved line is guaranteed to
  // be at input.warehouseId by the check above, so resolve the receiving warehouse's own labels once
  // rather than persisting nulls — the snapshot is what keeps history readable after a rename.
  let warehouseName = resolved[0].warehouseName;
  let warehouseCode = resolved[0].warehouseCode;
  if (warehouseName === null) {
    const wh = await warehouseRepo.findById(warehouseId);
    warehouseName = wh?.name ?? null;
    warehouseCode = wh?.code ?? null;
  }
  const engineerName = job.assignedEngineerName ?? "";
  const engineerEmail = job.assignedEngineerEmail ?? null;

  // Which ORDERS this return touches, so their panes can be told once it has landed. Deduped by id:
  // one return can credit several hires on the same order, and that is one refresh, not four.
  const hiresTouched = new Map<string, string>();
  for (const r of resolved) {
    if (r.line.source === "rental" && r.hirePurchaseOrderId) hiresTouched.set(r.hirePurchaseOrderId, r.hirePoCode ?? "");
  }

  const movementLines: goodsManagementRepo.MovementLineRow[] = resolved.map((r) => ({
    source: r.line.source,
    irmItemId: r.line.source === "irm" ? (r.line.irmItemId ?? null) : null,
    customerStockEntryId: r.line.source === "customer" ? (r.line.customerStockEntryId ?? null) : null,
    rentalItemId: r.line.source === "rental" ? (r.line.rentalItemId ?? null) : null,
    purchaseOrderRentalLineId: r.line.source === "rental" ? (r.hireId ?? null) : null,
    itemName: r.itemName,
    sku: r.sku,
    uom: r.uom,
    qty: r.line.qty,
    condition: r.condition,
    jobKitLineId: kitLineIdOf(r),
    scannedCode: r.line.scannedCode ?? null,
    damagePhotoUrl: r.condition === "damaged" ? (r.line.damagePhotoUrl ?? null) : null,
    damageReason: r.condition === "damaged" ? (r.line.damageReason ?? null) : null,
    notes: r.line.notes ?? null,
  }));

  // Per-warehouse return cap: at the line's HOME warehouse it can return only what's still out from
  // its kit line (issued − used − returned), so a multi-warehouse holding can't be fully returned at
  // one warehouse (over-crediting it + shorting the other). AWAY from home, only the van portion may
  // land (vanReturnableAwayFromHome). Computed from current movements; a running budget handles
  // multiple lines (e.g. good + damaged split) against the same kit line in one request.
  const returnMovements = await loadMovements();
  const awayVanQty = await completedVanQtyByKitLine(
    resolved.flatMap((r) => (r.awayReturn ? [kitLineIdOf(r)] : [])).filter((id): id is string => !!id),
  );
  const outstandingByLine = new Map<string, number>();
  for (const r of resolved) {
    // The SERVER's id, the same one the ledger row above was filed under. Keyed off the client's
    // instead, a line could be filed against A while its budget was drawn from B — so a second
    // return naming B would find B's budget untouched and over-credit the job.
    const klId = kitLineIdOf(r);
    if (!klId || outstandingByLine.has(klId)) continue;
    if (r.awayReturn) {
      outstandingByLine.set(klId, vanReturnableAwayFromHome(returnMovements, klId, r.kitHomeWarehouseId ?? null, awayVanQty.get(klId) ?? 0));
    } else {
      const s = kitLineSplit(returnMovements, klId);
      outstandingByLine.set(klId, Math.max(0, s.issued - s.used - s.returned));
    }
  }

  const created = await goodsManagementRepo.createMovementWithCode(
    {
      jobId: job.id,
      direction: "return",
      engineerId: job.assignedEngineerId!,
      engineerName,
      engineerEmail,
      warehouseId,
      warehouseName,
      warehouseCode,
      status: "posted",
      postedAt: new Date(),
      performedBy: actorEmail,
      createdBy: actorEmail,
    },
    movementLines,
    async (tx, movementId, code) => {
      for (const r of resolved) {
        const { line, condition, warehouseId: wh } = r;
        const qty = line.qty;

        // Per-warehouse cap: can't return more than the kit line still has out here — the whole line
        // at its home warehouse, or just the van portion away from home.
        const budgetLineId = kitLineIdOf(r);
        if (budgetLineId) {
          const remaining = outstandingByLine.get(budgetLineId) ?? 0;
          if (qty > remaining) {
            throw conflict(r.awayReturn
              ? `Only ${remaining} of ${r.itemName} came from a van and can be returned away from its home warehouse — the rest must go back there.`
              : `Only ${remaining} of ${r.itemName} can be returned at this warehouse — that's all that's still out from here.`);
          }
          outstandingByLine.set(budgetLineId, remaining - qty);
        }

        if (line.source === "irm") {
          const irmItemId = line.irmItemId!;
          // Pre-check: engineer must hold at least qty.
          const held = await engineerStockRepo.findEngineerBalanceTx(tx, irmItemId, job.assignedEngineerId!);
          if (!held || held.quantityOnHand < qty) {
            throw conflict(`Engineer doesn't hold ${qty} of this IRM item. Held: ${held?.quantityOnHand ?? 0}.`);
          }
          // Drain the engineer holding.
          const eng = await engineerStockRepo.upsertEngineerBalanceTx(tx, irmItemId, job.assignedEngineerId!, -qty);
          // Ledger row with type "job_return".
          await engineerStockRepo.insertEngineerTxnTx(tx, {
            irmItemId,
            engineerId: job.assignedEngineerId!,
            quantityDelta: -qty,
            type: "job_return",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: eng.quantityOnHand,
            createdBy: actorEmail,
          });

          if (condition === "good") {
            // Credit the warehouse back via applyInbound.
            await inventoryService.applyInbound(tx, {
              irmItemId,
              warehouseId: wh,
              quantity: qty,
              sourceType: "goods_management",
              sourceId: movementId,
              sourceCode: code,
              createdBy: actorEmail,
            });
          } else {
            // Damaged: credit the damaged pool.
            const damageKey: goodsManagementRepo.DamagedKey = {
              warehouseId: wh,
              ownerType: "company",
              irmItemId,
              customerStockEntryId: null,
              customerId: null,
              itemName: r.itemName,
            };
            const dmgBal = await goodsManagementRepo.upsertDamagedBalanceTx(tx, damageKey, qty);
            await goodsManagementRepo.insertDamagedTxnTx(tx, {
              warehouseId: wh,
              ownerType: "company",
              irmItemId,
              customerStockEntryId: null,
              customerId: null,
              quantityDelta: qty,
              reason: line.damageReason ?? "Damaged on return",
              notes: line.notes ?? null,
              photoUrl: line.damagePhotoUrl ?? null,
              sourceType: "goods_management_return",
              sourceId: movementId,
              sourceCode: code,
              balanceAfter: dmgBal.quantity,
              createdBy: actorEmail,
            });
          }
        } else if (line.source === "rental") {
          const hireId = r.hireId!;
          // Pre-check: engineer must actually be holding this hire.
          const held = await rentalCustodyRepo.findRentalHoldingTx(tx, hireId, job.assignedEngineerId!);
          if (!held || held.quantityOnHand < qty) {
            throw conflict(`Engineer doesn't hold ${qty} of this hire. Held: ${held?.quantityOnHand ?? 0}.`);
          }
          const back = await rentalCustodyRepo.upsertRentalHoldingTx(tx, hireId, job.assignedEngineerId!, -qty, {
            rentalItemId: held.rentalItemId,
            itemName: held.itemName,
            poCode: held.poCode,
            hireEndDate: held.hireEndDate,
          });
          await rentalCustodyRepo.insertRentalTxnTx(tx, {
            purchaseOrderRentalLineId: hireId,
            engineerId: job.assignedEngineerId!,
            quantityDelta: -qty,
            type: "job_return",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: back.quantityOnHand,
            notes: condition === "damaged" ? (line.damageReason ?? "Returned damaged") : null,
            createdBy: actorEmail,
          });
          // Release the units back into the hire's warehouse pool. This is the mirror of the issue's
          // conditional increment and it must not be skipped when the kit came back damaged: a damaged
          // tester is still physically on our shelf, still ours to give back to the provider, and still
          // counting against the hire's deadline. Leaving it "issued" would make the hire un-returnable
          // and park it on the overdue badge forever.
          const released = await poRepo.adjustHireIssuedQtyTx(tx, hireId, -qty);
          if (!released) throw conflict(`${r.itemName}: this hire's numbers moved while the return was posting. Refresh and scan again.`);

          // DAMAGE IS EVIDENCE, NOT A QUANTITY MOVE — and deliberately NOT DamagedStockBalance.
          //
          // That pool is for stock WE own, where a damaged unit is our loss to write off or reclaim.
          // A hire is the provider's equipment: the damage is a LIABILITY to them, settled through the
          // hire's own damage note (HDM) with their charge on it. Posting it to the damaged pool as
          // well would double-count one event against a charge the supplier bills once.
          //
          // So the photo and reason ride on the movement line (captured at the moment it is seen,
          // which is what makes them evidence rather than recollection), AND a custody-exit row is
          // opened against the hire. That row is what takes the unit out of the issuable pool: the
          // tester is still on our shelf and still going back to the provider, but it must never be
          // handed to the next engineer. The office settles it into a damage note later, and the gap
          // between the two is the PM's worklist.
          if (condition === "damaged") {
            await custodyExitRepo.createExitTx(tx, {
              purchaseOrderRentalLineId: hireId,
              purchaseOrderId: r.hirePurchaseOrderId!,
              poCode: r.hirePoCode ?? null,
              // The hire's own depot, not the scanning warehouse. The damage belongs to the order it
              // came off — that is the warehouse whose settle worklist owns it, and the scope every
              // rental permission check on it resolves against.
              warehouseId: r.hireWarehouseId!,
              kind: "damage",
              qty,
              itemName: r.itemName,
              custodyState: custodyExitRepo.CUSTODY_HELD_DAMAGED,
              reason: line.damageReason ?? "Returned damaged from a job",
              notes: line.notes ?? null,
              photoUrl: line.damagePhotoUrl ?? null,
              jobId: job.id,
              jobNumber: job.jobNumber ?? null,
              engineerId: job.assignedEngineerId ?? null,
              engineerName: job.assignedEngineerName ?? null,
              declaredBy: actorEmail,
              // One movement can carry a good line and a damaged line for the same kit line, but only
              // one damaged line per hire — so the movement is a stable idempotency key for a retry.
              sourceType: "goods_management_return",
              sourceId: movementId,
            });
          }
        } else {
          const customerStockEntryId = line.customerStockEntryId!;
          // Pre-check: engineer must hold at least qty.
          const held = await goodsManagementRepo.findCustomerHoldingTx(tx, customerStockEntryId, job.assignedEngineerId!);
          if (!held || held.quantityOnHand < qty) {
            throw conflict(`Engineer doesn't hold ${qty} of this customer item. Held: ${held?.quantityOnHand ?? 0}.`);
          }
          // Drain the customer holding.
          const hold = await goodsManagementRepo.upsertCustomerHoldingTx(tx, customerStockEntryId, job.assignedEngineerId!, -qty, {
            customerId: held.customerId,
            itemName: held.itemName,
          });
          // Ledger row.
          await goodsManagementRepo.insertCustomerHoldingTxnTx(tx, {
            customerStockEntryId,
            engineerId: job.assignedEngineerId!,
            quantityDelta: -qty,
            type: "job_return",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: hold.quantityOnHand,
            createdBy: actorEmail,
          });

          if (condition === "good") {
            // Credit the customer stock pool back.
            await goodsManagementRepo.adjustCustomerStockEntryQtyTx(tx, customerStockEntryId, qty);
          } else {
            // Damaged: credit the damaged pool (customer-owned). No pool credit for the customer entry.
            // Use customerId from the live holding (snapshot on the balance row).
            const effectiveCustomerId = held.customerId ?? r.customerId;
            const damageKey: goodsManagementRepo.DamagedKey = {
              warehouseId: wh,
              ownerType: "customer",
              irmItemId: null,
              customerStockEntryId,
              customerId: effectiveCustomerId,
              itemName: held.itemName,
            };
            const dmgBal = await goodsManagementRepo.upsertDamagedBalanceTx(tx, damageKey, qty);
            await goodsManagementRepo.insertDamagedTxnTx(tx, {
              warehouseId: wh,
              ownerType: "customer",
              irmItemId: null,
              customerStockEntryId,
              customerId: effectiveCustomerId,
              quantityDelta: qty,
              reason: line.damageReason ?? "Damaged on return",
              notes: line.notes ?? null,
              photoUrl: line.damagePhotoUrl ?? null,
              sourceType: "goods_management_return",
              sourceId: movementId,
              sourceCode: code,
              balanceAfter: dmgBal.quantity,
              createdBy: actorEmail,
            });
          }
        }
      }
      await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: "awaiting_return" });
    },
  );

  audit.record({ actor, action: "goods_management.return_posted", targetType: "job", targetId: job.id, targetLabel: created.code });

  // Realtime: notify the engineer + all office staff.
  const returnPayload = { jobId: job.id, movementId: created.id, code: created.code, direction: "return" };
  emitToUser(job.assignedEngineerId!, "goods:returned", returnPayload);
  // The HIRE panes too, when hired kit moved. A return changes `issuedQuantity`, the damaged count and
  // what may be issued — every number the warehouse's on-hire pane and the order page show — and none
  // of them were being told, so they sat stale until someone reloaded. Deduped by order: one return
  // can credit several hires on the same order, and that is one refresh, not four.
  for (const [poId, poCode] of hiresTouched) emitHireUpdated(poId, poCode);
  emitGoodsRoom("goods:updated", returnPayload);

  return toPublic(created);
}

// ── Consume movement (engineer Complete) ─────────────────────────────────────────────────────
// Called from job.service.completeJobForEngineer. Takes the already-loaded job to avoid a circular
// import (goods-management.service → job.repository; job.service → goods-management.service).
// Opens a single transaction that:
//   1. For each used line, drains the engineer holding (IRM via engineerStockRepo, customer via gmRepo).
//   2. Appends ledger rows with type "job_consume".
//   3. Creates a "consume" JobStockMovement (warehouseId null).
//   4. Stamps the job "completed" via jobRepository.completeIfInProgressTx.
//   5. Upserts the summary with goodsStatus "awaiting_return" + workSummary.
export interface ConsumeUsedLine {
  source: "irm" | "customer";
  irmItemId?: string;
  customerStockEntryId?: string;
  jobKitLineId?: string; // the exact kit line used — disambiguates an item issued from >1 warehouse
  qty: number;
}

// Match an engineer-declared "used" line to the EXACT kit line it came from: by declared kit-line id
// (precise when an item was issued from more than one warehouse), else by item id for older clients
// without jobKitLineId. The declared item MUST be on this job's kit list — otherwise we'd drain the
// engineer's (global) holding for an unrelated item with no traceable attribution. An unmatched line
// (off-job item, or a stale/edited jobKitLineId) is rejected, never silently orphaned.
function resolveUsedKitLine(job: JobWithRelations, used: ConsumeUsedLine): JobWithRelations["kitLines"][number] {
  const kitLine = job.kitLines.find((kl) =>
    used.jobKitLineId
      ? kl.id === used.jobKitLineId
      : used.source === "irm"
        ? kl.lineType === "irm" && kl.irmItemId === used.irmItemId
        : kl.lineType === "customer_stock" && kl.customerStockEntryId === used.customerStockEntryId,
  );
  if (!kitLine) throw badRequest("A declared 'used' item isn't on this job's kit list (or its line was edited) — refresh the job and try again.");
  // The id branch above matches on id ALONE, so it will happily hand back a `rental` (or `misc`) line
  // for a payload that declared `source: "irm"`. `completeJobSchema` bars rental from the SOURCE enum
  // but cannot see which line an id points at, so this is the only place the invariant can be checked.
  //
  // It is not theoretical. A consume booked against a rental line drains an unrelated IRM item AND
  // credits `used` to the hire, whose remaining then falls to 0 — so the line reads fully accounted
  // for, reconcile lets the job through, and the hire is still in a van with EngineerRentalHolding
  // still saying so. That is exactly the "a hire is never consumed" rule the schema, the enum and the
  // reconcile guard are all built around; this closes the last door into it.
  const expected = used.source === "irm" ? "irm" : "customer_stock";
  if (kitLine.lineType !== expected) {
    throw badRequest(
      kitLine.lineType === "rental"
        ? `${kitLine.itemName} is a hired item — it can't be declared as used. Hired kit is returned to the warehouse, never consumed.`
        : `A declared 'used' item doesn't match its kit line type — refresh the job and try again.`,
    );
  }
  return kitLine;
}

export async function recordConsumeAndComplete(
  job: JobWithRelations,
  engineerId: string,
  workSummary: string | null,
  usedLines: ConsumeUsedLine[],
  actorEmail: string | null,
): Promise<void> {
  const jobId = job.id;

  // Pre-build movement lines (item names from kit list snapshots); balances are re-checked inside tx.
  const movementLines: goodsManagementRepo.MovementLineRow[] = usedLines
    .filter((u) => u.qty > 0)
    .map((used) => {
      const kitLine = resolveUsedKitLine(job, used);
      return {
        source: used.source === "irm" ? "irm" : "customer",
        irmItemId: used.source === "irm" ? used.irmItemId ?? null : null,
        customerStockEntryId: used.source === "irm" ? null : used.customerStockEntryId ?? null,
        // Always null — a hire is never consumed. `completeJobSchema.usedLines[].source` admits only
        // "irm" and "customer", so a rental cannot reach this path at all; the nulls state the
        // invariant at the one place a future edit would be tempted to break it.
        rentalItemId: null,
        purchaseOrderRentalLineId: null,
        itemName: kitLine.itemName,
        sku: null,
        uom: null,
        qty: used.qty,
        condition: "good",
        jobKitLineId: kitLine.id,
        scannedCode: null,
        damagePhotoUrl: null,
        damageReason: null,
        notes: null,
      };
    });

  // Decide the goods status AFTER this consume: if the engineer is left holding NOTHING for the job
  // (used everything — nothing to return), auto-reconcile instead of parking it in "awaiting_return"
  // and forcing a manual Close & Reconcile. Outstanding per line = issued − used (prior + this) −
  // returned; if every line nets to 0, there's nothing to hand back.
  const priorMovements = await goodsManagementRepo.findMovementsByJob(jobId);
  const newUsedByLine = new Map<string, number>();
  for (const m of movementLines) if (m.jobKitLineId) newUsedByLine.set(m.jobKitLineId, (newUsedByLine.get(m.jobKitLineId) ?? 0) + m.qty);
  let totalOutstanding = 0;
  for (const kl of job.kitLines) {
    if (kl.lineType === "misc") continue; // misc isn't stock-tracked
    const s = kitLineSplit(priorMovements, kl.id);
    totalOutstanding += Math.max(0, s.issued - s.used - s.returned - (newUsedByLine.get(kl.id) ?? 0));
  }
  const finalGoodsStatus = totalOutstanding > 0 ? "awaiting_return" : "reconciled";

  // Use the GM code allocator so consume movements get proper GM-#### codes.
  await goodsManagementRepo.createMovementWithCode(
    {
      jobId,
      direction: "consume",
      engineerId,
      engineerName: job.assignedEngineerName ?? "",
      engineerEmail: job.assignedEngineerEmail ?? null,
      warehouseId: null,  // consume is engineer-declared; no warehouse
      warehouseName: null,
      warehouseCode: null,
      status: "posted",
      postedAt: new Date(),
      performedBy: actorEmail,
      createdBy: actorEmail,
    },
    movementLines,
    async (tx, movementId, code) => {
      // Inside the same transaction: drain holdings + ledger + stamp job + summary.
      for (const used of usedLines) {
        if (used.qty <= 0) continue;

        if (used.source === "irm") {
          if (!used.irmItemId) throw badRequest("IRM used line missing irmItemId.");
          // Pre-check: engineer must hold at least this qty.
          const held = await engineerStockRepo.findEngineerBalanceTx(tx, used.irmItemId, engineerId);
          if (!held || held.quantityOnHand < used.qty) {
            throw conflict(`Engineer doesn't hold ${used.qty} of this IRM item. Held: ${held?.quantityOnHand ?? 0}.`);
          }
          // Drain the engineer holding.
          const eng = await engineerStockRepo.upsertEngineerBalanceTx(tx, used.irmItemId, engineerId, -used.qty);
          // Append ledger row.
          await engineerStockRepo.insertEngineerTxnTx(tx, {
            irmItemId: used.irmItemId,
            engineerId,
            quantityDelta: -used.qty,
            type: "job_consume",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: eng.quantityOnHand,
            createdBy: actorEmail,
          });
        } else {
          if (!used.customerStockEntryId) throw badRequest("Customer used line missing customerStockEntryId.");
          // Pre-check: engineer must hold at least this qty.
          const held = await goodsManagementRepo.findCustomerHoldingTx(tx, used.customerStockEntryId, engineerId);
          if (!held || held.quantityOnHand < used.qty) {
            throw conflict(`Engineer doesn't hold ${used.qty} of this customer item. Held: ${held?.quantityOnHand ?? 0}.`);
          }
          // Drain the customer holding.
          const hold = await goodsManagementRepo.upsertCustomerHoldingTx(tx, used.customerStockEntryId, engineerId, -used.qty, {
            customerId: held.customerId,
            itemName: held.itemName,
          });
          // Append ledger row.
          await goodsManagementRepo.insertCustomerHoldingTxnTx(tx, {
            customerStockEntryId: used.customerStockEntryId,
            engineerId,
            quantityDelta: -used.qty,
            type: "job_consume",
            sourceType: "goods_management",
            sourceId: movementId,
            sourceCode: code,
            balanceAfter: hold.quantityOnHand,
            createdBy: actorEmail,
          });
        }
      }

      // Stamp job completed (atomic guard).
      const stamped = await jobRepo.completeIfInProgressTx(tx, jobId, engineerId);
      if (stamped.count !== 1) {
        throw conflict("Job can't be completed right now. Refresh and try again.");
      }

      // Upsert the summary (auto-reconciled when nothing's left to return — see above).
      await goodsManagementRepo.upsertSummaryTx(tx, jobId, {
        goodsStatus: finalGoodsStatus,
        workSummary: workSummary ?? null,
      });
    },
  );
}

// ── Damaged stock read ────────────────────────────────────────────────────────────────────────
// Exposes NO cost/value — only item/qty/serial/location/flag.
export interface DamagedRow {
  id: string;
  warehouseId: string;
  warehouseName: string | null;
  ownerType: string; // "company" | "customer"
  irmItemId: string | null;
  customerStockEntryId: string | null;
  customerId: string | null;
  itemName: string;
  quantity: number;
  updatedAt: string; // ISO date from DamagedStockBalance.updatedAt
  reason: string | null; // from latest DamagedStockTransaction
  photoUrl: string | null; // from latest DamagedStockTransaction
}

export async function listDamaged(
  filter: { warehouseId?: string; customerId?: string },
  actor?: AuditActor,
): Promise<DamagedRow[]> {
  const scopeIds = warehouseScopeFilter(actor);

  // Step 1: collect raw balance rows (now includes warehouse relation).
  type RawBalance = Awaited<ReturnType<typeof goodsManagementRepo.findDamagedByWarehouse>>[number];
  let rawBalances: RawBalance[] = [];

  if (filter.customerId) {
    const raw = await goodsManagementRepo.findDamagedByCustomer(filter.customerId);
    rawBalances = raw.filter((r) => scopeIds === undefined || scopeIds.includes(r.warehouseId));
  } else if (filter.warehouseId) {
    assertWarehouseAccess(actor, filter.warehouseId);
    rawBalances = await goodsManagementRepo.findDamagedByWarehouse(filter.warehouseId);
  } else {
    // No filter: return all warehouses the actor can access.
    const allWarehouseIds = scopeIds;
    if (allWarehouseIds !== undefined) {
      // Scoped: fetch per warehouse then merge.
      for (const whId of allWarehouseIds) {
        const raw = await goodsManagementRepo.findDamagedByWarehouse(whId);
        rawBalances.push(...raw);
      }
    } else {
      // Global actor: use repo's findAll-style query (no filter).
      rawBalances = await goodsManagementRepo.findAllDamaged();
    }
  }

  // Step 2: batch-fetch the latest transaction for each balance (reason + photoUrl).
  const latestTxnMap = await goodsManagementRepo.findLatestDamagedTxnsByBalances(rawBalances);

  // Step 3: assemble final rows.
  const rows: DamagedRow[] = rawBalances.map((r) => {
    const txn = latestTxnMap.get(r.id);
    return {
      id: r.id,
      warehouseId: r.warehouseId,
      warehouseName: r.warehouse?.name ?? null,
      ownerType: r.ownerType,
      irmItemId: r.irmItemId,
      customerStockEntryId: r.customerStockEntryId,
      customerId: r.customerId,
      itemName: r.itemName,
      quantity: r.quantity,
      updatedAt: r.updatedAt.toISOString(),
      reason: txn?.reason ?? null,
      photoUrl: txn?.photoUrl ?? null,
    };
  });

  return rows;
}

// ── Damaged history (drill-down behind one damaged row) ───────────────────────────────────────
// The damaged LIST can only ever surface the latest reason + photo per balance, because a balance
// is an aggregate — quantity only, no reason, no photo (see the DamagedStockBalance model). Every
// report's own reason and photo live on its DamagedStockTransaction row, which is append-only and
// never overwritten. This is the read path that makes those earlier reports reachable: without it,
// an item damaged twice showed report #2's evidence next to a quantity of 2 and report #1's reason
// and photo could not be retrieved from any screen — even though the system REQUIRES both to be
// captured before a damaged return can be posted.
export interface DamagedHistoryEntry {
  id: string;
  date: string; // ISO
  type: "write_off" | "restore"; // derived from the sign of quantityDelta
  quantityDelta: number; // + damaged reported, − restored to usable
  balanceAfter: number;
  reason: string;
  notes: string | null;
  photoUrl: string | null;
  sourceType: string;
  sourceCode: string | null;
  actor: string | null;
}

export interface DamagedHistoryResult {
  warehouseId: string;
  ownerType: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  itemName: string;
  quantity: number; // the balance's CURRENT quantity
  entries: DamagedHistoryEntry[];
  truncated: boolean; // true = the cap was hit and older entries exist beyond `entries`
}

// Defensive ceiling only — one item at one warehouse realistically has single-digit reports. If it
// is ever hit the result says so, so the UI can tell the user rather than quietly showing a partial
// history (a silent truncation on an evidence trail is worse than no history at all).
const DAMAGED_HISTORY_CAP = 200;

export async function getDamagedHistory(
  input: { warehouseId: string; ownerType: string; irmItemId: string | null; customerStockEntryId: string | null },
  actor?: AuditActor,
): Promise<DamagedHistoryResult> {
  // Same guard every other warehouse-keyed read in this service uses: a warehouse-scoped manager
  // may only drill into a warehouse they are actually assigned to.
  assertWarehouseAccess(actor, input.warehouseId);

  const key = {
    warehouseId: input.warehouseId,
    ownerType: input.ownerType,
    irmItemId: input.irmItemId,
    customerStockEntryId: input.customerStockEntryId,
  };

  // The balance is the anchor: it proves the row exists and carries the item-name snapshot + the
  // current quantity the entries should reconcile to.
  const balance = await goodsManagementRepo.findDamagedBalance(key);
  if (!balance) throw notFound("Damaged stock balance not found for the given item and warehouse.");

  // Ask for one MORE than the cap so a full page can be distinguished from an exactly-full one.
  const rows = await goodsManagementRepo.findDamagedTxnsByKey(key, DAMAGED_HISTORY_CAP + 1);
  const truncated = rows.length > DAMAGED_HISTORY_CAP;

  return {
    warehouseId: balance.warehouseId,
    ownerType: balance.ownerType,
    irmItemId: balance.irmItemId,
    customerStockEntryId: balance.customerStockEntryId,
    itemName: balance.itemName,
    quantity: balance.quantity,
    truncated,
    entries: rows.slice(0, DAMAGED_HISTORY_CAP).map((t) => ({
      id: t.id,
      date: t.createdAt.toISOString(),
      type: t.quantityDelta < 0 ? "restore" : "write_off",
      quantityDelta: t.quantityDelta,
      balanceAfter: t.balanceAfter,
      reason: t.reason,
      notes: t.notes,
      photoUrl: t.photoUrl,
      sourceType: t.sourceType,
      sourceCode: t.sourceCode,
      actor: t.createdBy,
    })),
  };
}

// ── Overdue holdings ──────────────────────────────────────────────────────────────────────────
// Jobs whose FIRST issue movement is older than `days` and that still have stock genuinely out with
// the engineer — outstanding = issued − used − returned, summed over the stock-tracked kit lines.
//
// It used to test `goodsStatus !== "reconciled"` and call that "still holds stock". Those are not the
// same thing: posting a return sets the status to "awaiting_return" unconditionally (see postReturn)
// and only an explicit Close & reconcile clears it, so a job whose stock had ALL come back sat in this
// list for as long as nobody closed it, day count climbing, offering to write off as "lost" stock that
// was already on the shelf. A chase list has to contain only what actually needs chasing, or people
// stop believing it.

const DEFAULT_OVERDUE_PAGE_SIZE = 20;
const MAX_OVERDUE_PAGE_SIZE = 100;

export interface OverdueParams {
  warehouseId?: string;
  /** Job number, job name or engineer name. */
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface OverduePage {
  rows: OverdueRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface OverdueRow {
  jobId: string;
  jobNumber: string;
  jobName: string;
  engineerId: string;
  engineerName: string;
  warehouseId: string | null;
  /** The issue movement this row reports — its code is shown, and it keys the row in the UI. */
  movementId: string;
  movementCode: string;
  issuedAt: Date;
  /** Whole days since `issuedAt`, computed SERVER-side so it can't disagree with the cutoff that
   *  selected the row (a browser clock running slow would otherwise show 13 days for a 14-day row). */
  daysOut: number;
  goodsStatus: string;
  /** The JOB's own status. A cancelled job on this list can only be returned or written off — the row
   *  showed no sign of it, so the state was visible inside the scan panel and nowhere else. */
  status: string;
  lines: { source: string; irmItemId: string | null; customerStockEntryId: string | null; itemName: string; qty: number }[];
}

// `warehouseId` scopes the read to one warehouse's issues. The per-warehouse Goods Management tab
// passes it; without it the tab showed every warehouse the actor could reach, so an admin standing
// in Warehouse A's tab was chasing Warehouse B's overdue jobs. The actor's own warehouse-access
// check below still applies on top — this narrows WHAT is asked for, it does not widen access.
/**
 * The work, against an ALREADY-RESOLVED window. Private on purpose: `days` is not a caller's choice.
 *
 * There was briefly a public override — a `days` parameter on the endpoint and on this function. It is
 * gone, because it was the seam through which this screen's one real bug could return: pass a number
 * below the configured threshold and you get a list of jobs that are NOT overdue by the company's rule,
 * which is exactly what the deleted UI picker did. Settings is the only place the window is chosen, so
 * "overdue" means one thing everywhere. If an audit report ever needs a different window, add a
 * parameter then, deliberately, with the window shown on whatever renders it.
 */
async function listOverdueWithin(days: number, actor?: AuditActor, opts: OverdueParams = {}): Promise<OverduePage> {
  const now = Date.now();
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
  const pageSize = Math.min(Math.max(Math.trunc(opts.pageSize ?? DEFAULT_OVERDUE_PAGE_SIZE), 1), MAX_OVERDUE_PAGE_SIZE);
  const empty = (): OverduePage => ({ rows: [], total: 0, page: 1, pageSize, totalPages: 1 });

  // 1) Start from OPEN jobs, not from the ledger. This is the read's cost ceiling: work in flight,
  // rather than every issue movement ever posted. Reversing these two steps is what used to make the
  // Overdue tab (and, once the Hub shared it, the Inventory Hub) slower every month regardless of how
  // much stock was actually out.
  //
  // A job is open unless its summary says `reconciled`. Note the direction: jobs are EXCLUDED by proof
  // of reconciliation, never included by proof of openness. A job with no summary row at all therefore
  // stays in — deliberately, and twice-decided in this codebase's history. `recomputeGoodsStatus`
  // (the engineer-transfer attribution path) is best-effort and swallows its own failure, so an
  // unreturned issue CAN exist with no summary; excluding it would drop the one thing a chase list must
  // never drop. listQueue makes the same choice, defaulting a missing summary to "not_issued".
  const activeJobIds = (await jobRepo.findGoodsActiveJobIds()).map((j) => j.id);
  if (activeJobIds.length === 0) return empty();
  const goodsStatusByJob = new Map(
    (await goodsManagementRepo.getSummariesByJobs(activeJobIds)).map((s) => [s.jobId, s.goodsStatus]),
  );
  const openJobIds = activeJobIds.filter((id) => goodsStatusByJob.get(id) !== "reconciled");
  if (openJobIds.length === 0) return empty();

  // 2) …then their issue movements older than the window, oldest first.
  const movements = await goodsManagementRepo.findOldIssueMovementsForJobs(
    openJobIds,
    cutoff,
    opts.warehouseId,
  );
  if (movements.length === 0) return empty();

  // 3) One row per job — its FIRST issue, since that is the one that has been out longest. Warehouse
  // access is checked here so an inaccessible job never reaches the count either.
  const firstIssueByJob = new Map<string, (typeof movements)[number]>();
  for (const m of movements) {
    if (firstIssueByJob.has(m.jobId)) continue;
    if (m.warehouseId) {
      try {
        assertWarehouseAccess(actor, m.warehouseId);
      } catch {
        continue; // skip movements the actor can't access
      }
    }
    firstIssueByJob.set(m.jobId, m);
  }
  const candidateJobIds = [...firstIssueByJob.keys()];
  if (candidateJobIds.length === 0) return empty();

  // 4) Is anything actually still out? Netted per kit line over the job's FULL movement history —
  // issued − used − returned — exactly the sum postConsume uses to decide whether a job can
  // auto-reconcile. `misc` lines are skipped: free-text, never stock-tracked, so they can't be handed
  // back and would hold a job in this list permanently. Both reads are batched over the candidates.
  const allMovementsByJob = new Map<string, Awaited<ReturnType<typeof goodsManagementRepo.findMovementsByJobs>>>();
  for (const m of await goodsManagementRepo.findMovementsByJobs(candidateJobIds)) {
    const list = allMovementsByJob.get(m.jobId);
    if (list) list.push(m);
    else allMovementsByJob.set(m.jobId, [m]);
  }
  const stillOut = new Set<string>();
  for (const j of await jobRepo.findKitLineTypesByJobs(candidateJobIds)) {
    const jobMovements = allMovementsByJob.get(j.id) ?? [];
    const outstanding = j.kitLines
      .filter((kl) => kl.lineType !== "misc")
      .reduce((total, kl) => {
        const s = kitLineSplit(jobMovements, kl.id);
        return total + Math.max(0, s.issued - s.used - s.returned);
      }, 0);
    if (outstanding > 0) stillOut.add(j.id);
  }

  // 5) Search, then count, then slice — in that order, so `total` and the page numbers describe the
  // SAME set the user is looking at.
  //
  // DELIBERATE DIVERGENCE: every other searchable list in this codebase pushes the term into Prisma via
  // `escapeRegex` (utils/search.ts) — this one matches in memory. It has to: the still-out test above
  // is computed from movement tallies, not stored, so a DB-side `contains` could only filter the raw
  // candidate pool and `total` would then count rows the user can't see. Matching after that filter is
  // what keeps the count honest. A plain substring test also can't be broken by a `(` or `*`, which is
  // the hazard escapeRegex exists to neutralise. If this ever moves DB-side, it must move BELOW the
  // still-out filter, which means denormalising outstanding quantity first.
  const term = opts.search?.trim().toLowerCase();
  const matched = [...firstIssueByJob.values()]
    .filter((m) => stillOut.has(m.jobId))
    .filter((m) =>
      !term ||
      [m.job?.jobNumber, m.job?.name, m.engineerName].some((f) => f?.toLowerCase().includes(term)),
    );

  const total = matched.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Math.trunc(opts.page ?? 1), 1), totalPages);
  // Already oldest-first from the query, so the page order is longest-overdue-first for free.
  const pageMovements = matched.slice((page - 1) * pageSize, page * pageSize);

  const rows: OverdueRow[] = pageMovements.map((m) => ({
    jobId: m.jobId,
    jobNumber: m.job?.jobNumber ?? m.jobId,
    jobName: m.job?.name ?? "",
    engineerId: m.engineerId,
    engineerName: m.engineerName,
    warehouseId: m.warehouseId,
    movementId: m.id,
    movementCode: m.code,
    issuedAt: m.createdAt,
    daysOut: Math.max(0, Math.floor((now - m.createdAt.getTime()) / 86_400_000)),
    goodsStatus: goodsStatusByJob.get(m.jobId) ?? "issued",
    status: m.job?.status ?? "",
    lines: m.items.map((l) => ({
      source: l.source,
      irmItemId: l.irmItemId,
      customerStockEntryId: l.customerStockEntryId,
      itemName: l.itemName,
      qty: l.qty,
    })),
  }));

  return { rows, total, page, pageSize, totalPages };
}

/** One page of overdue rows for the configured window. The window is not a parameter — see above. */
export async function listOverdue(actor?: AuditActor, opts: OverdueParams = {}): Promise<OverduePage> {
  return listOverdueWithin(await getOverdueAfterDays(), actor, opts);
}

/**
 * How many jobs are overdue, company-wide — the Inventory Hub's "N overdue" on the With-engineers card.
 *
 * Shares the list's definition so the card and the tab can never disagree, but asks for a ONE-row page:
 * it wants `total`, not the rows, and building a few hundred row objects just to read `.length` was
 * work the Hub's page load had no reason to pay for. It used to be
 * `jobStockMovement.count({ direction: "issue", createdAt: { lt: cutoff } })`, which answered a
 * different question in three ways — it counted MOVEMENTS (a job issued in three scans counted three),
 * it never excluded reconciled jobs, and it never checked whether anything was still out.
 */
export async function getOverdueSummary(actor?: AuditActor): Promise<{ count: number; days: number }> {
  // Asks for a ONE-row page: it wants `total` and the window, not the rows, and building hundreds of
  // row objects to read a length off them was work these callers had no reason to pay for. Passing the
  // actor scopes the count to warehouses they can reach (omit it for the company-wide read).
  const { total, days } = await getOverdueView(actor, { pageSize: 1 });
  return { count: total, days };
}

/**
 * The Overdue tab's payload: a page of rows AND the window they were selected with.
 *
 * The window is returned because the screen must not assume it — it lives in Settings, so a page that
 * printed a hardcoded "14" would start lying the moment an admin changed the value. Resolved once here
 * (rather than read again inside the list) so the number the UI prints is provably the number the query
 * ran with, from a single read.
 */
export async function getOverdueView(
  actor?: AuditActor,
  opts: OverdueParams = {},
): Promise<{ days: number } & OverduePage> {
  const days = await getOverdueAfterDays();
  return { days, ...(await listOverdueWithin(days, actor, opts)) };
}

// ── Close & reconcile ─────────────────────────────────────────────────────────────────────────
// Computes per-item tally: issued − consumed − returnedGood − returnedDamaged.
// If all zero → goodsStatus = "reconciled" (locked).
// If any positive and writeOffLost → drain remaining engineer holding with type "job_lost" + reconcile.
// If any positive and no writeOffLost → return the unaccounted list and leave open.

interface UnaccountedItem {
  itemName: string;
  itemCode: string | null;
  qty: number;
  source: "irm" | "customer" | "rental";
  irmItemId: string | null;
  /** Rental lines only — the key the per-hire detail is looked up by. */
  rentalItemId: string | null;
  customerStockEntryId: string | null;
  warehouseId: string | null;
  customerId: string | null;
}

/**
 * Hired kit a job still has out, as the reconcile screen needs it.
 *
 * `hires` is what turns a message into an action: it names the exact hire and the order it sits on, so
 * the screen can offer Declare lost where the operator already is, exactly as an unaccounted COMPANY
 * item is offered a write-off. Empty when the outstanding units cannot be traced to a hire — a movement
 * line written before hire ids existed — and the row is still listed, just without the button.
 */
export interface RentalOutstandingRow {
  itemName: string;
  itemCode: string | null;
  qty: number;
  /**
   * Who is holding them — this job's own engineer, always.
   *
   * On the payload rather than left to the client to thread through, because a loss is declared AGAINST
   * A NAMED PERSON: it writes off somebody else's equipment and the name belongs on the record. There
   * is no ambiguity to resolve — units out on this job are out with the engineer assigned to it — so
   * the server states it once instead of every screen re-deriving it.
   */
  engineerId: string | null;
  engineerName: string | null;
  hires: { purchaseOrderRentalLineId: string; purchaseOrderId: string; poCode: string | null; qty: number }[];
}

type TallyEntry = { jobKitLineId: string; itemName: string; itemCode: string | null; source: "irm" | "customer" | "rental"; irmItemId: string | null; rentalItemId: string | null; customerStockEntryId: string | null; warehouseId: string | null; issued: number; consumed: number; returnedGood: number; returnedDamaged: number };

// Tally goods for reconciliation, keyed by the job's CURRENT, stock-tracked kit lines (jobKitLineId).
// Keying by kit line — not by item id — keeps this consistent with the held / queue / job-pack views
// and ignores movements left over from kit lines that were later edited or removed (whose ids no
// longer match), which would otherwise double-count an item. Misc lines are free-text (not
// stock-tracked) and can never be returned, so they're excluded from reconciliation entirely.
function computeTallies(
  movements: readonly MovementTally[],
  kitLines?: NonNullable<JobWithRelations["kitLines"]>,
): Map<string, TallyEntry> {
  const tallies = new Map<string, TallyEntry>();
  for (const kl of kitLines ?? []) {
    if (kl.lineType === "misc") continue; // misc is not stock-tracked → never reconciled
    tallies.set(kl.id, {
      jobKitLineId: kl.id,
      itemName: kl.itemName,
      // The catalogue code, from relations the job already carries. `itemName` is a snapshot frozen on
      // the kit line and is NOT reliably unique — the catalogue holds e.g. IRM-0002 "Cat6 U/UTP Cable
      // 305m Box" and IRM-0004 "CAT6 U/UTP Cable, 305m box", which read as the same thing. Writing off
      // the wrong one is irreversible, so the code travels with the row.
      itemCode: kl.irmItem?.code ?? kl.rentalItem?.code ?? kl.seCode ?? null,
      // Three-way, NOT the old `irmItemId ? "irm" : "customer"` ternary. That binary treated anything
      // without an IRM id as customer stock, so a rental line reconciled as a customer consignment —
      // draining a holding that does not exist and offering hired equipment for write-off as our own
      // loss. A rental is neither of the other two and has to say so.
      source: kl.rentalItemId ? "rental" : kl.irmItemId ? "irm" : "customer",
      irmItemId: kl.irmItemId ?? null,
      rentalItemId: kl.rentalItemId ?? null,
      customerStockEntryId: kl.customerStockEntryId ?? null,
      warehouseId: kl.warehouseId ?? null,
      issued: 0,
      consumed: 0,
      returnedGood: 0,
      returnedDamaged: 0,
    });
  }

  for (const m of movements) {
    if (m.status !== "posted") continue;
    for (const l of m.items) {
      if (!l.jobKitLineId) continue;
      const t = tallies.get(l.jobKitLineId);
      if (!t) continue; // orphaned (kit line edited/removed) or misc — not part of this job's reconcile
      if (m.direction === "issue") t.issued += l.qty;
      else if (m.direction === "consume") t.consumed += l.qty; // includes "lost" write-offs
      else if (m.direction === "return") {
        if (l.condition === "damaged") t.returnedDamaged += l.qty;
        else t.returnedGood += l.qty;
      }
    }
  }

  return tallies;
}

export async function closeReconcile(
  jobId: string,
  input: CloseReconcileInput,
  actor?: AuditActor,
): Promise<{
  summary: { goodsStatus: string; workSummary: string | null; lastMovementAt: Date | null };
  unaccounted: { itemName: string; itemCode: string | null; qty: number }[];
  /** Hired kit still out. Non-empty ⇒ the job stayed `awaiting_return` however the write-off went. */
  rentalOutstanding: RentalOutstandingRow[];
}> {
  const job = await loadJobOrThrow(jobId);
  const existingSummary = await goodsManagementRepo.getSummary(job.id);

  if (existingSummary?.goodsStatus === "reconciled") {
    throw conflict("This job is already reconciled and locked.");
  }

  const movements = await goodsManagementRepo.findMovementsByJob(job.id);

  // Guard: reconcile ONLY once the engineer has completed the job (goodsStatus "awaiting_return").
  // Before that the stock is still in use on site — reconciling would write off live stock as "lost"
  // and lock the job. Issued / partially_issued jobs must wait for the engineer to declare usage.
  //
  // …with ONE exception, which is the whole reason the Overdue tab exists: an engineer who has simply
  // gone quiet never presses Complete, so their job never reaches awaiting_return, so the tab's
  // "Write off (lost)" was locked in precisely the situation it was built for. A job whose stock has
  // been out longer than the configured window is past waiting for that declaration.
  //
  // TWO independent conditions, and both must hold:
  //
  //  1. `input.fromOverdue` — the request came from the Overdue tab. This screen is a deliberate, rare
  //     manager action; the warehouse SCAN PANEL posts to this same endpoint dozens of times a day, and
  //     without the marker it inherited the relaxation and could reconcile (and write off) a job the
  //     engineer is still working, locking it against any further issue or return.
  //  2. The stock really is past the window. Read from Settings, NEVER from the caller — the same rule,
  //     read the same way, that selected the row on the Overdue tab in the first place (see
  //     listOverdueWithin). So the marker in (1) is routing, not authority: it cannot close a job whose
  //     stock went out yesterday. `firstIssueAt` comes from the job's own posted issue movements — no
  //     issue at all means nothing is out, and no amount of age makes that writeable-off.
  if (existingSummary?.goodsStatus !== "awaiting_return") {
    if (!input.fromOverdue) {
      throw conflict("This job can only be reconciled after the engineer completes it and declares what was used.");
    }
    const firstIssueAt = movements
      .filter((m) => m.status === "posted" && m.direction === "issue")
      .reduce<Date | null>((oldest, m) => (!oldest || m.createdAt < oldest ? m.createdAt : oldest), null);
    const cutoff = new Date(Date.now() - (await getOverdueAfterDays()) * 24 * 60 * 60 * 1000);
    if (!firstIssueAt || firstIssueAt >= cutoff) {
      throw conflict("This job can only be reconciled after the engineer completes it and declares what was used.");
    }
  }
  const tallies = computeTallies(movements, job.kitLines ?? []);

  // "Unaccounted" must reflect what the engineer ACTUALLY still holds — not raw per-line issued −
  // returned. Stock returned at a different warehouse, or (for a customer-stock entry shared across
  // jobs) handed back under another job, is genuinely accounted even though THIS job's per-line
  // movements don't record the return. So cap each item's unaccounted at the engineer's real held
  // balance (the same source the scan/queue use), distributed across the item's kit lines. Without
  // this, reconcile shows phantom shortfalls and the only escapes are a wrong "write off as lost" or
  // leaving the job stuck open.
  const engId = job.assignedEngineerId;
  const irmHeld = new Map<string, number>();
  const cseHeld = new Map<string, number>();
  let rentalHeld = new Map<string, RentalHeld>();
  // Per-hire detail for the rental leg, from the same holdings read — which hire, on which order, so the
  // screen can offer the action instead of only naming the problem.
  let jobHires = new Map<string, JobHireOutstanding[]>();
  if (engId) {
    for (const b of await engineerStockRepo.findEngineerBalances(engId)) irmHeld.set(b.irmItemId, b.quantityOnHand);
    for (const h of await goodsManagementRepo.findCustomerHoldingsByEngineer(engId)) cseHeld.set(h.customerStockEntryId, h.quantityOnHand);
    const holdings = await rentalCustodyRepo.findRentalHoldingsByEngineer(engId);
    rentalHeld = rentalHeldFrom(holdings);
    jobHires = jobHiresOutstanding(movements as never, holdings);
  }

  // Group the tallies by item (the engineer holding is global per item, not per kit line) and spread
  // each item's real held across its lines, capped at each line's raw remaining.
  const talliesByItem = new Map<string, TallyEntry[]>();
  for (const t of tallies.values()) {
    // The rental arm is LOAD-BEARING, not symmetry for its own sake. Without it every rental tally
    // fell to `cse:undefined` — one bucket for every hire on the job — and the cap below then read
    // `held` from the FIRST item only. Two hires out, the first one already back, and the whole
    // bucket capped to 0: `unaccountedItems` came out empty and the guard at the end of this function
    // (the one that refuses to reconcile with hired kit still out) never fired. Keyed the same way as
    // getJobKitTallies groups them, so the two cannot drift.
    const key =
      t.source === "irm"
        ? `irm:${t.irmItemId}`
        : t.source === "rental"
          ? `rental:${t.rentalItemId}`
          : `cse:${t.customerStockEntryId}`;
    const g = talliesByItem.get(key);
    if (g) g.push(t);
    else talliesByItem.set(key, [t]);
  }

  // ONE entry per ITEM, not per kit line. The same item can sit on two kit lines of a job and both be
  // short, which used to produce two rows with the identical name and different numbers — indis-
  // tinguishable from a bug on a screen asking you to approve a permanent loss. Summing is safe: the
  // drain below keys off irmItemId / customerStockEntryId (never the kit line), the lost movement lines
  // carry `jobKitLineId: null` anyway, and `warehouseId`/`customerId` on this shape are unread.
  const unaccountedItems: UnaccountedItem[] = [];
  for (const group of talliesByItem.values()) {
    const first = group[0];
    const held =
      first.source === "irm"
        ? irmHeld.get(first.irmItemId!) ?? 0
        : first.source === "rental"
          ? rentalHeld.get(first.rentalItemId!)?.qty ?? 0
          : cseHeld.get(first.customerStockEntryId!) ?? 0;
    const rawRemaining = group.reduce((n, t) => n + Math.max(0, t.issued - t.consumed - t.returnedGood - t.returnedDamaged), 0);
    const qty = Math.min(rawRemaining, held); // never more than the engineer truly holds
    if (qty > 0) {
      unaccountedItems.push({
        itemName: first.itemName,
        itemCode: first.itemCode,
        qty,
        source: first.source,
        irmItemId: first.irmItemId,
        rentalItemId: first.rentalItemId,
        customerStockEntryId: first.customerStockEntryId,
        warehouseId: first.warehouseId,
        customerId: null,
      });
    }
  }

  // HIRED KIT IS NEVER WRITTEN OFF AS LOST — but it no longer stops the rest of the job either.
  //
  // "Write off as lost" books a permanent loss of something WE own. Hired equipment is the provider's:
  // an unreturned unit is not a loss to absorb, it is a liability to settle — they will keep billing
  // for it and then charge us for the replacement. Booking it as our own shrinkage would state
  // something untrue in the stock ledger AND take the hire off the deadline badge that is still the
  // only thing chasing it. So a rental row is never written off here, and it is filtered out of the
  // list below rather than offered.
  //
  // What it USED to do was throw, and that was the defect. Two unrelated things were tied together:
  // an outstanding hire refused the whole reconcile, so a shortfall on a COMPANY item — a different
  // pool, a different owner, a different decision — could not be booked either, and the screen showed
  // only an error where the unaccounted list should have been. Ownership domains reconcile
  // independently; one domain's unfinished business is not another's.
  //
  // The hire still holds the job open, which is a different rule and lives further down: the job's
  // TERMINAL state waits for it, because reconciling locks the job against any further scan and a
  // hire still in a van has to be able to come back. See `rentalOutstanding` at the summary write.
  //
  // The list is built from the per-ITEM tally, deliberately, because that is what `canGoTerminal` is
  // decided on and it needs no hire id to be correct — a movement line written before hires carried
  // one still counts toward "something is out". The per-HIRE detail is then attached where it can be
  // resolved, so the screen can offer Declare lost on the exact hire; a row that cannot be matched
  // still appears, just without the action. Degrading that way keeps a legacy line visible instead of
  // silently dropping it out of the guard.
  const rentalOutstanding: RentalOutstandingRow[] = unaccountedItems
    .filter((u) => u.source === "rental")
    .map((u) => {
      const hires = (u.rentalItemId ? jobHires.get(u.rentalItemId) : undefined) ?? [];
      return {
        itemName: u.itemName,
        itemCode: u.itemCode,
        qty: u.qty,
        engineerId: job.assignedEngineerId ?? null,
        engineerName: job.assignedEngineerName ?? null,
        hires: hires.map((h) => ({
          purchaseOrderRentalLineId: h.purchaseOrderRentalLineId,
          purchaseOrderId: h.purchaseOrderId,
          poCode: h.poCode,
          qty: h.qty,
        })),
      };
    });
  const writeOffCandidates = unaccountedItems.filter((u) => u.source !== "rental");

  const actorEmail = actor?.email ?? null;

  // THE TERMINAL STATE IS NOT THE SAME DECISION AS THE WRITE-OFF.
  //
  // `reconciled` LOCKS the job: `postIssue` and `postReturn` both refuse one, by design — a closed job
  // must not keep moving stock. That makes it the wrong state for a job whose hired kit is still in a
  // van, because the only way those units can ever come home is the return scan the lock would forbid.
  // Reconciling here would trade one dead end for a worse one.
  //
  // So the write-off runs (above), and the job simply stays where it was: `awaiting_return`, which is
  // exactly what it means. No new status — the existing machine already has the word for "we are still
  // waiting on something". The hire is resolved by scanning it back or declaring it lost, and the next
  // reconcile finds nothing outstanding and closes.
  const canGoTerminal = rentalOutstanding.length === 0;
  const finalStatus = canGoTerminal ? "reconciled" : "awaiting_return";

  if (writeOffCandidates.length > 0 && !input.writeOffLost) {
    // Company/customer units are unaccounted for and the caller has not confirmed writing them off.
    // Hand the list back and change nothing — the confirmation screen is built from it.
    return {
      summary: existingSummary
        ? { goodsStatus: existingSummary.goodsStatus, workSummary: existingSummary.workSummary, lastMovementAt: existingSummary.lastMovementAt }
        : { goodsStatus: "awaiting_return", workSummary: null, lastMovementAt: null },
      unaccounted: writeOffCandidates.map((u) => ({ itemName: u.itemName, itemCode: u.itemCode, qty: u.qty })),
      rentalOutstanding,
    };
  }

  // Either balanced (no unaccounted) or writeOffLost = true.
  //
  // One reason string, written to every ledger row this write-off produces and quoted in the audit
  // entry, so the stock trail and the audit log tell the same story. Empty when nothing is being
  // written off (a clean reconcile has no reason to give).
  const wroteOffAnything = writeOffCandidates.length > 0 && input.writeOffLost === true;
  const writeOffNote = wroteOffAnything
    ? [input.writeOffReason, input.writeOffNotes?.trim()].filter(Boolean).join(" — ")
    : null;
  const writeOffUnits = wroteOffAnything ? writeOffCandidates.reduce((n, u) => n + u.qty, 0) : 0;

  // Build lost movement lines for unaccounted items.
  // condition: "lost" distinguishes these write-off consume lines from normal consumes in the audit ledger.
  const lostLines: goodsManagementRepo.MovementLineRow[] = writeOffCandidates.map((u) => ({
    source: u.source,
    irmItemId: u.irmItemId,
    customerStockEntryId: u.customerStockEntryId,
    // Always null, and unreachable: the guard above throws before this point if any unaccounted row
    // is a rental, because hired equipment is never written off as our own loss.
    rentalItemId: null,
    purchaseOrderRentalLineId: null,
    itemName: u.itemName,
    sku: null,
    uom: null,
    qty: u.qty,
    condition: "lost",
    jobKitLineId: null,
    scannedCode: null,
    damagePhotoUrl: null,
    damageReason: "written off as lost",
    notes: null,
  }));

  if (lostLines.length > 0) {
    // Write the lost movement + drain holdings + upsert summary in one transaction.
    await goodsManagementRepo.createMovementWithCode(
      {
        jobId: job.id,
        direction: "consume",
        engineerId: job.assignedEngineerId!,
        engineerName: job.assignedEngineerName ?? "",
        engineerEmail: job.assignedEngineerEmail ?? null,
        warehouseId: null,
        warehouseName: null,
        warehouseCode: null,
        status: "posted",
        postedAt: new Date(),
        performedBy: actorEmail,
        createdBy: actorEmail,
      },
      lostLines,
      async (tx, movementId, code) => {
        for (const u of writeOffCandidates) {
          if (u.source === "irm") {
            const held = await engineerStockRepo.findEngineerBalanceTx(tx, u.irmItemId!, job.assignedEngineerId!);
            const heldQty = held?.quantityOnHand ?? 0;
            // Drain however much is actually held (may be less than unaccounted if already written off).
            if (heldQty > 0) {
              const drainQty = Math.min(u.qty, heldQty);
              const eng = await engineerStockRepo.upsertEngineerBalanceTx(tx, u.irmItemId!, job.assignedEngineerId!, -drainQty);
              await engineerStockRepo.insertEngineerTxnTx(tx, {
                irmItemId: u.irmItemId!,
                engineerId: job.assignedEngineerId!,
                quantityDelta: -drainQty,
                type: "job_lost",
                sourceType: "goods_management",
                sourceId: movementId,
                sourceCode: code,
                balanceAfter: eng.quantityOnHand,
                // The WHY, on the ledger row itself. Without it the stock trail records that units
                // vanished and who signed it off, but never why — which is the one question asked
                // about a write-off months later.
                notes: writeOffNote,
                createdBy: actorEmail,
              });
            }
          } else {
            const held = await goodsManagementRepo.findCustomerHoldingTx(tx, u.customerStockEntryId!, job.assignedEngineerId!);
            const heldQty = held?.quantityOnHand ?? 0;
            if (heldQty > 0) {
              const drainQty = Math.min(u.qty, heldQty);
              const hold = await goodsManagementRepo.upsertCustomerHoldingTx(
                tx,
                u.customerStockEntryId!,
                job.assignedEngineerId!,
                -drainQty,
                { customerId: held!.customerId, itemName: held!.itemName },
              );
              await goodsManagementRepo.insertCustomerHoldingTxnTx(tx, {
                customerStockEntryId: u.customerStockEntryId!,
                engineerId: job.assignedEngineerId!,
                quantityDelta: -drainQty,
                type: "job_lost",
                sourceType: "goods_management",
                sourceId: movementId,
                sourceCode: code,
                balanceAfter: hold.quantityOnHand,
                notes: writeOffNote, // same reason trail as the company-stock path above
                createdBy: actorEmail,
              });
            }
          }
        }
        await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: finalStatus });
      },
    );
  } else {
    // Balanced (nothing to write off) — just update the summary.
    await withTransaction(async (tx) => {
      await goodsManagementRepo.upsertSummaryTx(tx, job.id, { goodsStatus: finalStatus });
    });
  }

  // ── WHAT THIS RUN ACTUALLY DID, SAID ONCE AND SAID HONESTLY ──────────────────────────────────
  //
  // Three things are decided here and all three read `canGoTerminal`, because they are three ways of
  // announcing the SAME outcome and any of them disagreeing is a lie somebody will act on.
  //
  // "Reconciled" is a claim about the job being FINISHED, and it must never be made when the job is
  // still `awaiting_return`. It was: a hire outstanding left the job open (correctly) while the audit
  // log recorded `goods_management.reconciled` anyway, the engineer's screen was pushed a reconcile
  // event, and the operator was shown a success toast and sent back to the queue. The one artefact
  // anyone checks months later — the audit trail — said a job closed that never did.
  //
  // A run that only ended up deferred is still worth recording: it is a person deciding to close a job
  // and being told they cannot yet, which is exactly the trail that explains why a job sat open. So it
  // gets its OWN action rather than silence, and the label names what stopped it.
  const deferredLabel = rentalOutstanding.map((u) => `${u.qty} × ${u.itemName}`).join(", ");

  // A write-off gets its OWN action, not the same "reconciled" line as a clean close. Both used to
  // record `goods_management.reconciled` with just the job number, so the audit log could not tell a
  // job that balanced from one where units were booked as lost — you had to go digging in the engineer
  // ledger to find out. The label carries the quantity and the reason, which is what anyone auditing
  // shrinkage actually needs.
  //
  // RECORDED ON ITS OWN, not as one arm of the outcome ternary, because the write-off and the close are
  // two independent facts about this run — the same independence the reconcile itself is built on. As
  // an arm it was reachable only when `canGoTerminal`, so a deferring hire SWALLOWED it: the stock was
  // written off exactly as it is below, and the only entry written said `reconcile_deferred`. Nothing
  // recorded the quantity or the reason, and nothing ever would — the next run finds the holdings
  // already drained, so `writeOffCandidates` is empty and it records a plain `reconciled`. Units left
  // the ledger with no audit line anywhere naming them.
  if (wroteOffAnything) {
    audit.record({
      actor,
      action: "goods_management.written_off_lost",
      targetType: "job",
      targetId: job.id,
      targetLabel: `${job.jobNumber ?? job.id} — ${writeOffUnits} unit${writeOffUnits === 1 ? "" : "s"} written off as lost: ${writeOffNote}`,
    });
  }

  // …and separately, what happened to the JOB. A clean close still says so; a close that wrote units
  // off is already fully described by the entry above and does not get a second line saying the same
  // run finished.
  if (!canGoTerminal) {
    audit.record({
      actor,
      action: "goods_management.reconcile_deferred",
      targetType: "job",
      targetId: job.id,
      targetLabel: `${job.jobNumber ?? job.id} — still on hire: ${deferredLabel}`,
    });
  } else if (!wroteOffAnything) {
    audit.record({ actor, action: "goods_management.reconciled", targetType: "job", targetId: job.id, targetLabel: job.jobNumber ?? job.id });
  }

  // Realtime: notify the engineer + all office staff.
  //
  // `direction` carries the outcome so a listener does not have to infer it. An engineer whose screen
  // is told "reconcile" locks its kit list; telling it that while their van still holds a hired tester
  // would hide the one row they still have to act on.
  const reconcilePayload = { jobId: job.id, direction: canGoTerminal ? "reconcile" : "reconcile_deferred" };
  emitToUser(job.assignedEngineerId!, "goods:returned", reconcilePayload);
  emitGoodsRoom("goods:updated", reconcilePayload);

  const updatedSummary = await goodsManagementRepo.getSummary(job.id);
  return {
    summary: updatedSummary
      ? { goodsStatus: updatedSummary.goodsStatus, workSummary: updatedSummary.workSummary, lastMovementAt: updatedSummary.lastMovementAt }
      : { goodsStatus: finalStatus, workSummary: null, lastMovementAt: null },
    unaccounted: [],
    // What is still holding the job open, named. Silently leaving it un-reconciled would send the user
    // back to a screen that looks unchanged with no clue why — the failure the old hard throw was at
    // least loud about, and the one thing worth keeping from it.
    rentalOutstanding,
  };
}

// ── Report damage on stock already in a warehouse ────────────────────────────────────────────
// The EXACT INVERSE of restoreDamaged below: moves units out of usable stock and into the damaged
// pool, in one atomic transaction. Company → InventoryBalance + InventoryTransaction("write_off");
// customer → CustomerStockEntry.quantity. Both branches then credit DamagedStockBalance and append
// a DamagedStockTransaction carrying the mandatory reason + photo.
//
// This is the third writer into the damaged pool, alongside a job return and a van return. Those
// two only fire when stock comes back FROM the field, which left the commonest case — a box crushed
// in our own racking, a leak overnight — with no correct action. Customer-owned consignment stock is
// deliberately in scope: it sits in our warehouse as someone else's property, so damaging it is the
// case with real liability attached and the one most needing a photo on file.
//
// The source document is the DamagedStockBalance row itself (`sourceId: dmgBal.id`), mirroring how
// restoreDamaged references it — there is no separate header record for a damage report.
const WAREHOUSE_DAMAGE_SOURCE_TYPE = "warehouse_damage_report";

export interface ReportDamageResult {
  warehouseId: string;
  ownerType: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  quantityDamaged: number;
  damagedBalanceAfter: number;
  usableBalanceAfter: number;
}

export async function reportWarehouseDamage(input: ReportDamageInput, actor?: AuditActor): Promise<ReportDamageResult> {
  const actorEmail = actor?.email ?? null;
  const isCompany = input.ownerType === "company";
  // Force the unused socket to null: a damaged balance is keyed with exactly one of the two set, so
  // carrying both would create a row that neither the list nor the history could ever match.
  const irmItemId = isCompany ? (input.irmItemId ?? null) : null;
  const customerStockEntryId = isCompany ? null : (input.customerStockEntryId ?? null);

  // This WRITES at this warehouse — same guard as every other warehouse-keyed write here.
  assertWarehouseAccess(actor, input.warehouseId);

  const warehouse = await warehouseRepo.findById(input.warehouseId);
  if (!warehouse) throw notFound("Warehouse not found.");

  let itemName: string;
  let customerId: string | null = null;

  if (isCompany) {
    const item = await irmService.requireActiveIrmItem(irmItemId!);
    // Same restriction the downward stock adjustment applies: writing off a serial- or batch-tracked
    // unit has to name WHICH serial/batch, and the damaged pool is quantity-only. Allowing it here
    // would silently decouple the serial register from the balance.
    if (item.trackSerialNumbers || item.trackBatchNumbers) {
      throw conflict("Serial- and batch-tracked items can't be reported damaged this way.");
    }
    itemName = item.name;
  } else {
    const entry = await goodsManagementRepo.findCustomerStockEntryById(customerStockEntryId!);
    if (!entry) throw notFound("Customer stock entry not found.");
    // The entry carries its own warehouse; reporting it damaged "at" a different one would credit a
    // damaged row the entry's own location can never reconcile with.
    if (entry.warehouseId !== input.warehouseId) {
      throw conflict("That customer stock isn't held at this warehouse.");
    }
    itemName = entry.itemName;
    customerId = entry.customerId;
  }

  let damagedBalanceAfter = 0;
  let usableBalanceAfter = 0;
  // Kept for the audit entry below, which addresses the damaged balance rather than the warehouse.
  let damagedBalanceId = "";

  await withTransaction(async (tx) => {
    // 1. Credit the damaged pool FIRST — its row id is the source reference for both ledger rows.
    const dmgBal = await goodsManagementRepo.upsertDamagedBalanceTx(
      tx,
      { warehouseId: input.warehouseId, ownerType: input.ownerType, irmItemId, customerStockEntryId, customerId, itemName },
      input.quantity,
    );
    damagedBalanceAfter = dmgBal.quantity;
    damagedBalanceId = dmgBal.id;

    // 2. Take the units OUT of usable stock. Both helpers throw inside the transaction if this
    //    would drive the holding below zero (upsertBalanceTx / adjustCustomerStockEntryQtyTx), so
    //    an over-report rolls the damaged credit back too rather than inventing stock.
    if (isCompany) {
      const bal = await inventoryRepo.upsertBalanceTx(tx, irmItemId!, input.warehouseId, -input.quantity);
      usableBalanceAfter = bal.quantityOnHand;
      await inventoryRepo.insertTransactionTx(tx, {
        irmItemId: irmItemId!,
        warehouseId: input.warehouseId,
        quantityDelta: -input.quantity,
        type: "write_off", // already labelled "Marked Damaged" in the movement history
        sourceType: WAREHOUSE_DAMAGE_SOURCE_TYPE,
        sourceId: dmgBal.id,
        sourceCode: null,
        balanceAfter: usableBalanceAfter,
        notes: input.notes ?? null,
        createdBy: actorEmail,
      });
    } else {
      const entry = await goodsManagementRepo.adjustCustomerStockEntryQtyTx(tx, customerStockEntryId!, -input.quantity);
      usableBalanceAfter = entry.quantity;
    }

    // 3. The evidence row — reason + photo, same shape a field return writes.
    await goodsManagementRepo.insertDamagedTxnTx(tx, {
      warehouseId: input.warehouseId,
      ownerType: input.ownerType,
      irmItemId,
      customerStockEntryId,
      customerId,
      quantityDelta: input.quantity,
      reason: input.reason,
      notes: input.notes ?? null,
      photoUrl: input.damagePhotoUrl,
      sourceType: WAREHOUSE_DAMAGE_SOURCE_TYPE,
      sourceId: dmgBal.id,
      sourceCode: null,
      balanceAfter: dmgBal.quantity,
      createdBy: actorEmail,
    });
  });

  // Addressed and namespaced EXACTLY like `restoreDamaged` below, because they are the same event in
  // opposite directions. Two things depended on getting this right:
  //   - `goods_management.*`, not `inventory.*`. Every other action this module records is in its own
  //     namespace; the odd one out is the one nobody thinks to search for.
  //   - the damaged BALANCE as the target, not the warehouse. The audit trail is read by target, so
  //     splitting a report and its restore across two target types means whichever screen you open
  //     shows you half the story — units going damaged with no sign of the restore that reversed
  //     them, or the reverse. The warehouse stays in `metadata`, where it's still queryable.
  audit.record({
    actor,
    action: "goods_management.damage_reported",
    targetType: "damaged_stock_balance",
    targetId: damagedBalanceId,
    targetLabel: `${itemName} · ${input.quantity} damaged @ ${warehouse.name}`,
    metadata: { warehouseId: input.warehouseId, ownerType: input.ownerType, irmItemId, customerStockEntryId, customerId, quantity: input.quantity, reason: input.reason },
  });

  return {
    warehouseId: input.warehouseId,
    ownerType: input.ownerType,
    irmItemId,
    customerStockEntryId,
    quantityDamaged: input.quantity,
    damagedBalanceAfter,
    usableBalanceAfter,
  };
}

// ── Damaged Restore (reverse a write-off) ────────────────────────────────────────────────────
// Decrements the DamagedStockBalance, appends a reversal DamagedStockTransaction, and credits
// the units back to usable stock — company → InventoryBalance + InventoryTransaction;
// customer → CustomerStockEntry.quantity. All in one atomic transaction.
export interface RestoreDamagedResult {
  warehouseId: string;
  ownerType: string;
  irmItemId: string | null;
  customerStockEntryId: string | null;
  quantityRestored: number;
  damagedBalanceAfter: number;
  usableBalanceAfter: number;
}

export async function restoreDamaged(input: RestoreDamagedInput, actor?: AuditActor): Promise<RestoreDamagedResult> {
  const actorEmail = actor?.email ?? null;
  const irmItemId = input.irmItemId ?? null;
  const customerStockEntryId = input.customerStockEntryId ?? null;

  // A restore WRITES: it moves units out of the damaged pool and credits usable stock at this
  // warehouse. The balance is addressed by its natural key (warehouse + item), not by an id the
  // caller could only have obtained from a permitted read — so without this guard a
  // warehouse-scoped manager could restore stock into a warehouse they are not assigned to. Every
  // other warehouse-keyed write in this service asserts access; this one was missing it.
  assertWarehouseAccess(actor, input.warehouseId);

  // Load the damaged balance by natural key.
  const balance = await goodsManagementRepo.findDamagedBalance({
    warehouseId: input.warehouseId,
    ownerType: input.ownerType,
    irmItemId,
    customerStockEntryId,
  });
  if (!balance) throw notFound("Damaged stock balance not found for the given item and warehouse.");
  if (balance.quantity <= 0) throw conflict("No damaged units remain to restore.");
  if (input.quantity > balance.quantity) {
    throw conflict(`Only ${balance.quantity} damaged unit(s) available — cannot restore ${input.quantity}.`);
  }

  let damagedBalanceAfter = 0;
  let usableBalanceAfter = 0;

  await withTransaction(async (tx) => {
    // 1. Decrement damaged balance + append reversal ledger row.
    damagedBalanceAfter = await goodsManagementRepo.decrementDamagedBalanceTx(tx, balance.id, input.quantity, {
      warehouseId: input.warehouseId,
      ownerType: input.ownerType,
      irmItemId,
      customerStockEntryId,
      customerId: balance.customerId,
      quantityDelta: -input.quantity,
      reason: "restore",
      notes: input.notes,
      photoUrl: null,
      sourceType: "damaged_restore",
      sourceId: balance.id,
      sourceCode: null,
      createdBy: actorEmail,
    });

    // 2. Return units to usable stock.
    if (input.ownerType === "company" && irmItemId) {
      // Company stock: upsert InventoryBalance and append an InventoryTransaction.
      const updatedBal = await inventoryRepo.upsertBalanceTx(tx, irmItemId, input.warehouseId, input.quantity);
      usableBalanceAfter = updatedBal.quantityOnHand;
      await inventoryRepo.insertTransactionTx(tx, {
        irmItemId,
        warehouseId: input.warehouseId,
        quantityDelta: input.quantity,
        type: "restore",
        sourceType: "damaged_restore",
        sourceId: balance.id,
        sourceCode: null,
        balanceAfter: usableBalanceAfter,
        notes: input.notes,
        createdBy: actorEmail,
      });
    } else if (customerStockEntryId) {
      // Customer stock: credit the CustomerStockEntry via the shared, negative-guarded qty-adjust helper.
      const updated = await goodsManagementRepo.adjustCustomerStockEntryQtyTx(tx, customerStockEntryId, input.quantity);
      usableBalanceAfter = updated.quantity;
    }
  });

  audit.record({
    actor,
    action: "goods_management.damaged_restored",
    targetType: "damaged_stock_balance",
    targetId: balance.id,
    targetLabel: balance.itemName,
    metadata: {
      warehouseId: input.warehouseId,
      ownerType: input.ownerType,
      irmItemId,
      customerStockEntryId,
      quantity: input.quantity,
      notes: input.notes,
    },
  });

  return {
    warehouseId: input.warehouseId,
    ownerType: input.ownerType,
    irmItemId,
    customerStockEntryId,
    quantityRestored: input.quantity,
    damagedBalanceAfter,
    usableBalanceAfter,
  };
}
