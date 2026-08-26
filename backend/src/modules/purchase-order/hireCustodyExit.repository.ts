/**
 * Hired equipment that has left normal usable custody — returned broken, or never returned at all.
 *
 * Every writer here follows the same two-step shape: write the EVENT row, then recompute the hire
 * line's cached counter as an ABSOLUTE from the live rows. Never increment. That is the rule the
 * module's own history is built on — `damagedQuantity` is recomputed from live note lines for exactly
 * this reason, and an increment written beside it survived only until the next reversal and then
 * vanished. Recomputing means the counter cannot drift from the rows it summarises, whatever order
 * concurrent writes land in.
 *
 * The counters are what the hot path reads: `adjustHireIssuedQtyTx` bounds an issue on them inside a
 * single-document conditional update, which is what makes the availability check and the commitment
 * one atomic operation. Counting these rows in there instead would split it back into two.
 */

import type { HireCustodyExit, Prisma } from "@prisma/client";

import { prisma } from "../../lib/prisma.js";
import { hireAtWarehouse } from "./rentalHire.allocation.js";

export type ExitKind = "damage" | "loss";

/** Where the units physically are — a different question from whether the provider has been paid. */
export const CUSTODY_HELD_DAMAGED = "held_damaged";
/**
 * Broken, and gone back to the provider on a collection note.
 *
 * The ONE way damaged hire equipment leaves us: it is still theirs, so it travels back with everything
 * else and the damage is argued afterwards. Never set by a note — no collection note can say WHICH
 * damaged units went back — but derived from the shelf by `reconcileDamageCustodyTx`.
 *
 * Still chargeable, deliberately. The provider's invoice for the damage arrives AFTER they have the
 * kit, which is exactly why custody and settlement are two columns; the guards that refuse a charge
 * name `withdrawn` and `recovered` and must go on naming only those.
 */
export const CUSTODY_RETURNED_TO_SUPPLIER = "returned_to_supplier";
/**
 * The report that opened this exit was withdrawn — so the units were never damaged of record and go
 * back to the issuable pool. Only reachable by reversing the note that CREATED the row; withdrawing a
 * note that merely settled someone else's damage report leaves the damage exactly where it was.
 */
export const CUSTODY_WITHDRAWN = "withdrawn";
export const CUSTODY_LOST = "lost";
export const CUSTODY_RECOVERED = "recovered";

/** Whether the provider has been settled with. Independent of custody — see the model's own note. */
export const SETTLE_UNSETTLED = "unsettled";
export const SETTLE_SETTLED = "settled";
export const SETTLE_DISMISSED = "dismissed";

export interface NewCustodyExit {
  purchaseOrderRentalLineId: string;
  purchaseOrderId: string;
  poCode: string | null;
  warehouseId: string;
  kind: ExitKind;
  qty: number;
  /** What it was, snapshotted — the panes that list these show an item, not an event. */
  itemName: string;
  custodyState: string;
  reason: string;
  notes?: string | null;
  photoUrl?: string | null;
  jobId?: string | null;
  jobNumber?: string | null;
  engineerId?: string | null;
  engineerName?: string | null;
  movementLineId?: string | null;
  declaredBy: string | null;
  /**
   * WHEN it was declared, for the callers that know something the clock does not.
   *
   * Omitted by the ordinary ones — a return scan and a loss declaration ARE the declaration, so the
   * column's `now()` is the truth and the default says so. Supplied by the two that are recording an
   * event that happened earlier: an office damage report carries the day the damage was found, and a
   * migration carries the date the row it is rebuilding always had.
   *
   * The field was missing before this, and its absence was not a gap in a comment — it was a wrong
   * date on screen. A backfill wrote a hire's damage history in one afternoon and every record it
   * created was dated that afternoon, then `recomputeCountersTx` copied that day onto the hire line's
   * `fieldDamageReportedAt`, overwriting the real one. "When was this found" had become "when did the
   * migration run", on the one screen where that date is argued over with a supplier.
   *
   * An INSTANT, always. A calendar day picked on a form goes through `instantForDay` first — see the
   * hazard documented there.
   */
  declaredAt?: Date;
  sourceType: string;
  sourceId: string;
}

/**
 * The counters, rebuilt from the rows that justify them.
 *
 * `fieldDamageQty` counts damage still ON OUR SHELF — a unit already handed back to the provider is
 * off it, because the question the counter answers is "what here must not go out again". `lostQuantity`
 * counts CURRENT unresolved loss, so a recovered unit leaves it and the row stays as history.
 *
 * Both in one pass because both writers need both: a recovery can be recorded against a hire that also
 * holds damage, and reading one while writing the other would leave the pair momentarily inconsistent
 * inside the same transaction.
 */
/**
 * AN EXIT THAT IS STILL WORK — the single definition the badge and the list both read.
 *
 * TWO ARMS, running in opposite directions:
 *
 *   • unsettled — nobody has put this to the provider yet, or priced what they put. A recovered loss
 *     is excluded: the unit turned up and nothing was ever agreed, so nothing is owed either way.
 *   • recovered AND settled — we PAID for a unit that then turned up. The equipment came back on its
 *     own; the money did not.
 *
 * A withdrawn report falls out of both (`dismissed`), correctly — the claim never happened.
 *
 * EXPORTED because the two readers used to express it differently and quietly disagreed. The list
 * filtered hire lines on their CACHED COUNTERS while the badge counted exit rows on settlement state,
 * so a collected-but-unpriced damage was counted and shown nowhere (an unclearable badge), and a
 * warehouse report born settled sat on the list forever without being counted. Counters cannot
 * express this question at all: `fieldDamageQty` counts what is damaged and HERE, which is a
 * different fact from what is unsettled.
 */
export const OPEN_EXIT_WHERE: Prisma.HireCustodyExitWhereInput = {
  OR: [
    { settlementState: SETTLE_UNSETTLED, NOT: { custodyState: CUSTODY_RECOVERED } },
    { custodyState: CUSTODY_RECOVERED, settlementState: SETTLE_SETTLED },
  ],
};

export async function recomputeCountersTx(tx: Prisma.TransactionClient, lineId: string): Promise<{ fieldDamageQty: number; lostQuantity: number }> {
  const rows = await tx.hireCustodyExit.findMany({
    where: { purchaseOrderRentalLineId: lineId },
    select: { kind: true, custodyState: true, qty: true, declaredAt: true },
  });
  let fieldDamageQty = 0;
  let lostQuantity = 0;
  let earliestOpenDamageAt: Date | null = null;
  for (const r of rows) {
    if (r.kind === "damage" && r.custodyState === CUSTODY_HELD_DAMAGED) {
      fieldDamageQty += r.qty;
      if (!earliestOpenDamageAt || r.declaredAt < earliestOpenDamageAt) earliestOpenDamageAt = r.declaredAt;
    } else if (r.kind === "loss" && r.custodyState === CUSTODY_LOST) {
      lostQuantity += r.qty;
    }
  }
  await tx.purchaseOrderRentalLine.update({
    where: { id: lineId },
    data: {
      fieldDamageQty,
      lostQuantity,
      // The date of the EARLIEST open report, taken from the rows themselves — not `new Date()`.
      // Stamping "now" here would rewrite the reported-on date every time anything else touched the
      // hire, turning "when was this damage found" into "when did someone last do anything", which is
      // a different fact and a worse one. Cleared once nothing is open.
      fieldDamageReportedAt: earliestOpenDamageAt,
    },
  });
  return { fieldDamageQty, lostQuantity };
}

/**
 * Record an exit and refresh the hire's counters, in the caller's transaction.
 *
 * IDEMPOTENT by `(sourceType, sourceId, hireLine, kind)`. A retried request — a double-tapped button, a
 * client replaying after a dropped response — resolves to the same key, the unique index refuses the
 * insert, and this returns the row that already exists rather than reporting the same tester broken
 * twice. The counter recompute still runs, so a first attempt that died between the insert and the
 * recompute is repaired by the retry.
 */
export async function createExitTx(tx: Prisma.TransactionClient, data: NewCustodyExit): Promise<HireCustodyExit> {
  let row: HireCustodyExit;
  try {
    row = await tx.hireCustodyExit.create({
      data: {
        ...data,
        notes: data.notes ?? null,
        photoUrl: data.photoUrl ?? null,
        jobId: data.jobId ?? null,
        jobNumber: data.jobNumber ?? null,
        engineerId: data.engineerId ?? null,
        engineerName: data.engineerName ?? null,
        movementLineId: data.movementLineId ?? null,
        settlementState: SETTLE_UNSETTLED,
      },
    });
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    const existing = await tx.hireCustodyExit.findFirst({
      where: {
        sourceType: data.sourceType,
        sourceId: data.sourceId,
        purchaseOrderRentalLineId: data.purchaseOrderRentalLineId,
        kind: data.kind,
      },
    });
    if (!existing) throw e;
    row = existing;
  }
  await recomputeCountersTx(tx, data.purchaseOrderRentalLineId);
  return row;
}

/** Prisma's unique-constraint code. Narrow rather than `instanceof`, which crosses client instances badly. */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/**
 * Move a specific exit's CUSTODY state — a lost unit found, a damaged one collected by the provider.
 *
 * Conditional on the state it is moving FROM, so two concurrent recoveries of the same declaration
 * cannot both succeed and give the units back twice. The caller turns `false` into a 409.
 */
export async function moveCustodyStateTx(
  tx: Prisma.TransactionClient,
  exitId: string,
  from: string,
  to: string,
  extra: Prisma.HireCustodyExitUncheckedUpdateInput = {},
): Promise<boolean> {
  const res = await tx.hireCustodyExit.updateMany({ where: { id: exitId, custodyState: from }, data: { custodyState: to, ...extra } });
  return res.count === 1;
}

/**
 * Withdraw a damage report — the claim never happened.
 *
 * Accepts the record whether the units are STILL HERE or have already gone back to the provider, and
 * the second is the case that matters: a wrong report is most often discovered when the provider
 * disputes their invoice, which is weeks after they collected. Refusing it then would leave a claim we
 * know to be wrong with no way to retract it, on the one order where somebody is arguing about it.
 *
 * Withdrawing gone equipment is arithmetically safe — a withdrawn row is counted by nothing, and the
 * shelf it would have been counted against is empty either way.
 *
 * `recovered` and an already-`withdrawn` row are refused by omission: neither has a live claim to take
 * back, and the caller turns `false` into a 409 rather than reporting a withdrawal that did nothing.
 */
export async function withdrawDamageExitTx(tx: Prisma.TransactionClient, exitId: string): Promise<boolean> {
  const res = await tx.hireCustodyExit.updateMany({
    where: { id: exitId, custodyState: { in: [CUSTODY_HELD_DAMAGED, CUSTODY_RETURNED_TO_SUPPLIER] } },
    data: { custodyState: CUSTODY_WITHDRAWN, settlementState: SETTLE_DISMISSED },
  });
  return res.count === 1;
}

/** Move an exit's SETTLEMENT state. Never touches custody — a credit note does not find a lost tester. */
export async function moveSettlementStateTx(
  tx: Prisma.TransactionClient,
  exitId: string,
  from: string,
  to: string,
  extra: Prisma.HireCustodyExitUncheckedUpdateInput = {},
): Promise<boolean> {
  const res = await tx.hireCustodyExit.updateMany({ where: { id: exitId, settlementState: from }, data: { settlementState: to, ...extra } });
  return res.count === 1;
}

/**
 * EVERY exit on one order, newest first — the order page's custody timeline.
 *
 * Unfiltered, deliberately. A withdrawn report and a recovered loss are exactly what somebody asking
 * "why does this order not add up" needs to see; hiding them would leave the quantities changing for
 * no readable reason, which is the thing recording events rather than counters exists to prevent.
 */
export function findByOrder(purchaseOrderId: string): Promise<HireCustodyExit[]> {
  return prisma.hireCustodyExit.findMany({ where: { purchaseOrderId }, orderBy: { declaredAt: "desc" } });
}

/** Every exit still awaiting an answer from the office, for one order — the settle screen's list. */
export function findOpenByOrder(purchaseOrderId: string): Promise<HireCustodyExit[]> {
  return prisma.hireCustodyExit.findMany({
    where: { purchaseOrderId, settlementState: SETTLE_UNSETTLED },
    orderBy: { declaredAt: "desc" },
  });
}

/**
 * Open exits at a set of warehouses — the damaged-stock pane's rental segment and its badge.
 *
 * Rental damage is served from HERE and never from `DamagedStockBalance`: that pool is owned stock,
 * where a damaged unit is our loss to write off or reclaim. A hire is the provider's, so its damage is
 * a charge to settle with them, and putting it in the owned pool would count one fault twice — once as
 * our shrinkage and once on the invoice they raise. The rental/inventory boundary test pins that.
 */
export function findOpenByWarehouses(warehouseIds: string[] | undefined, kind?: ExitKind): Promise<HireCustodyExit[]> {
  return prisma.hireCustodyExit.findMany({
    where: {
      ...(warehouseIds ? { warehouseId: { in: warehouseIds } } : {}),
      ...(kind ? { kind } : {}),
      settlementState: SETTLE_UNSETTLED,
      // A withdrawn report never happened and a recovered loss is back on the shelf — neither is work
      // anybody still owes an answer on.
      //
      // `returned_to_supplier` is excluded for a DIFFERENT reason, and the difference is the whole
      // point of the two-column model. This feeds the DAMAGED STOCK pane — "what is broken in this
      // building" — and equipment the provider has collected is not in the building, however much we
      // still owe for it. The money side asks a different question through `OPEN_EXIT_WHERE`
      // (`unsettledCustodyWhere` and the settle worklist), which keeps counting a collected unit
      // precisely because the invoice has not been settled.
      NOT: { custodyState: { in: [CUSTODY_WITHDRAWN, CUSTODY_RECOVERED, CUSTODY_RETURNED_TO_SUPPLIER] } },
    },
    orderBy: { declaredAt: "desc" },
  });
}

/**
 * Damage still owed a note, per hire line — units already reported but not yet on any provider paper.
 *
 * THE OTHER HALF OF THE DOUBLE-COUNT `settleOpenDamageAgainstNoteTx` GUARDS. That one stops a second
 * CUSTODY row being opened for one fault; this one stops the provider-facing TALLY being advanced
 * twice for it.
 *
 * A job return opens a damage exit and deliberately leaves `damagedQuantity` alone — the tally moves
 * when the exit is settled, either by a warehouse note (which consumes it) or by `chargeCustodyExit`.
 * A collection note in the gap knew nothing about that pending claim: its own cap is against units
 * NEVER recorded damaged, and an unsettled exit has recorded nothing yet. So the office could name the
 * same broken unit on the collection note AND charge its still-open exit afterwards, and one fault
 * reached the supplier's damaged total twice — on a 1-unit hire, as `damagedQuantity: 2`.
 *
 * `returned_to_supplier` counts alongside `held_damaged`: the driver taking a broken unit away settles
 * nothing, and that exit is still going to be charged. Only `withdrawn` drops out, because a withdrawn
 * report never happened.
 */
export async function openDamageQtyByLines(lineIds: string[]): Promise<Map<string, number>> {
  const totals = new Map<string, number>();
  if (lineIds.length === 0) return totals;
  const rows = await prisma.hireCustodyExit.findMany({
    where: {
      purchaseOrderRentalLineId: { in: lineIds },
      kind: "damage",
      settlementState: SETTLE_UNSETTLED,
      custodyState: { in: [CUSTODY_HELD_DAMAGED, CUSTODY_RETURNED_TO_SUPPLIER] },
    },
    select: { purchaseOrderRentalLineId: true, qty: true },
  });
  for (const r of rows) {
    totals.set(r.purchaseOrderRentalLineId, (totals.get(r.purchaseOrderRentalLineId) ?? 0) + r.qty);
  }
  return totals;
}

/** Exits on a set of hire lines — the hire panes and the job's own evidence list. */
export function findByHireLines(lineIds: string[]): Promise<HireCustodyExit[]> {
  if (lineIds.length === 0) return Promise.resolve([]);
  return prisma.hireCustodyExit.findMany({
    where: { purchaseOrderRentalLineId: { in: lineIds } },
    orderBy: { declaredAt: "desc" },
  });
}

/**
 * Settle up to `qty` units of a hire's ALREADY-OPEN damage against a note being raised now, and return
 * how many were covered.
 *
 * THE DOUBLE-COUNT THIS EXISTS TO PREVENT. An engineer brings a tester back broken: the return scan
 * opens an exit and the unit leaves the issuable pool. The office then raises the provider's damage
 * note for that same tester. Creating a second exit for it would quarantine ONE physical unit twice —
 * the hire would lose two units of availability for one fault, and no screen would explain why.
 *
 * So a note CONSUMES the open reports first and only opens a row for whatever it reports beyond them.
 * Oldest first, because the earliest report is the one that has been waiting.
 *
 * Custody is deliberately untouched: a unit with an agreed charge on it is still broken and still on
 * the shelf, so it stays `held_damaged` and stays out of the issuable pool. Only the settlement moves.
 *
 * A row larger than what is left to cover is SPLIT rather than partly settled — one row cannot be half
 * on a note. The remainder keeps standing as an open report, which is the honest reading of a note that
 * accepts one of the two units someone reported.
 *
 * "COVERED" MEANS "ALREADY ACCOUNTED FOR", NOT "SETTLED ONTO THIS NOTE". The two differ for a
 * DISMISSED report, whose unit is still physically quarantined while its claim is closed: the note
 * cannot settle it, but it must not open a second row for it either. See phase two in the body — that
 * distinction is the whole reason this returns a number instead of void.
 */
export async function settleOpenDamageAgainstNoteTx(
  tx: Prisma.TransactionClient,
  lineId: string,
  qty: number,
  receiptId: string,
  settledAt: Date,
): Promise<number> {
  return settleOpenAgainstNoteTx(tx, lineId, "damage", qty, receiptId, settledAt);
}

async function settleOpenAgainstNoteTx(
  tx: Prisma.TransactionClient,
  lineId: string,
  kind: ExitKind,
  qty: number,
  receiptId: string,
  settledAt: Date,
): Promise<number> {
  if (qty <= 0) return 0;
  // The custody state a still-open exit of this kind is in. A damaged unit withdrawn, or a lost one
  // recovered, is not physically quarantined at all and must never be swept onto a note.
  const heldState = kind === "loss" ? CUSTODY_LOST : CUSTODY_HELD_DAMAGED;
  const open = await tx.hireCustodyExit.findMany({
    where: {
      purchaseOrderRentalLineId: lineId,
      kind,
      custodyState: heldState,
      settlementState: SETTLE_UNSETTLED,
    },
    orderBy: { declaredAt: "asc" },
  });

  let left = qty;
  for (const row of open) {
    if (left <= 0) break;
    if (row.qty <= left) {
      const moved = await moveSettlementStateTx(tx, row.id, SETTLE_UNSETTLED, SETTLE_SETTLED, { settledByReceiptId: receiptId, settledAt });
      if (!moved) continue; // someone settled it in the window; the note simply covers less
      left -= row.qty;
      continue;
    }
    // Bigger than what is left: split off the settled part and leave the rest open.
    //
    // The slice's key carries WHICH slice it is. One exit can be split more than once — two partial
    // damage notes a week apart against the same engineer-reported damage — and keyed on `sourceId`
    // alone the second one repeats the first's key exactly. The unique index then refuses the insert
    // as a raw P2002, outside `createExitTx`'s catch, so the whole note 500s and no further damage
    // note can ever be raised on that hire.
    const slices = await tx.hireCustodyExit.count({ where: { sourceId: row.id } });
    const reduced = await tx.hireCustodyExit.updateMany({
      where: { id: row.id, qty: row.qty, settlementState: SETTLE_UNSETTLED },
      data: { qty: row.qty - left },
    });
    if (reduced.count !== 1) continue;
    await tx.hireCustodyExit.create({
      data: {
        purchaseOrderRentalLineId: row.purchaseOrderRentalLineId,
        purchaseOrderId: row.purchaseOrderId,
        poCode: row.poCode,
        warehouseId: row.warehouseId,
        kind,
        qty: left,
        itemName: row.itemName,
        custodyState: row.custodyState,
        settlementState: SETTLE_SETTLED,
        reason: row.reason,
        notes: row.notes,
        photoUrl: row.photoUrl,
        jobId: row.jobId,
        jobNumber: row.jobNumber,
        engineerId: row.engineerId,
        engineerName: row.engineerName,
        movementLineId: row.movementLineId,
        declaredBy: row.declaredBy,
        declaredAt: row.declaredAt,
        settledByReceiptId: receiptId,
        settledAt,
        // Keyed on the SPLIT so it cannot collide with the parent row's own key.
        sourceType: `${kind}_split_${slices}`,
        sourceId: row.id,
      },
    });
    left = 0;
  }

  // ── PHASE TWO: units already quarantined that this note can no longer settle ──────────────────
  //
  // THE SPLIT THIS FUNCTION EXISTS ON. It does two different jobs in one pass, and they do not have
  // the same filter:
  //
  //   • FINANCIAL — move an open claim onto the note being raised. That is `unsettled` rows only,
  //     which is the loop above.
  //   • PHYSICAL  — make sure ONE broken unit is not quarantined twice. That is every row physically
  //     holding a unit off the shelf, whatever the office decided about the money.
  //
  // A DISMISSED row is the case where the two answers differ. "Nothing is owed" closes the claim; it
  // does not un-break the tester, so the unit is still `held_damaged` and still out of the issuable
  // pool. Phase one cannot see it — correctly, because settling a dismissed row would silently charge
  // the provider for a report the office had already dropped. But when the note reported that same
  // physical unit, phase one returned "covered 0", the caller opened a SECOND exit for it, and
  // `recomputeCountersTx` — which counts `custodyState` and ignores settlement — then read TWO held
  // rows for ONE unit. On a 1-unit hire that is `fieldDamageQty: 2`, and the next
  // `reconcileDamageCustodyTx` derives `gone = total − shelf = 1` and sends the older row to
  // `returned_to_supplier`, recording a collection that never happened.
  //
  // So the leftover is ABSORBED against dismissed rows: it counts as covered, and NOTHING is written.
  // Not settled (the office dropped that claim and a later note must not silently reopen it), not
  // reduced, not split — the row is already the record of that unit being off the shelf, and the note
  // adds nothing to it. Only the RETURN VALUE moves, which is what stops the caller minting a
  // duplicate.
  //
  // Runs AFTER phase one deliberately: live claims are worth more on a note than closed ones, so the
  // note settles everything it actually can before the remainder is written off as already-accounted.
  //
  // The provider still gets charged for what they were sent — the note carries its own
  // `damagedQuantity` and the caller advances the hire's provider-facing tally from it. What does not
  // happen is a second quarantine of one physical unit.
  if (left > 0) {
    const alreadyHeld = await tx.hireCustodyExit.findMany({
      where: {
        purchaseOrderRentalLineId: lineId,
        kind,
        custodyState: heldState,
        settlementState: SETTLE_DISMISSED,
      },
      orderBy: { declaredAt: "asc" },
      select: { qty: true },
    });
    for (const row of alreadyHeld) {
      if (left <= 0) break;
      // Partial absorption needs no split: nothing about the row changes either way, so there is no
      // second state for a slice of it to carry.
      left -= Math.min(left, row.qty);
    }
  }

  return qty - left;
}

/**
 * The `sourceType` on a slice this reconciliation cut off a bigger record. See below for why it counts.
 */
const CUSTODY_SPLIT = "damage_custody_split";

/**
 * MAKE THE DAMAGE RECORDS AGREE WITH WHAT IS ACTUALLY ON THE SHELF.
 *
 * A hire has exactly one way for damaged equipment to leave our custody: it goes back to the provider
 * on a collection note, damage and all. Nothing recorded that. `returned_to_supplier` was declared and
 * displayed and never once written, so a record went on saying "Damaged, still here" after the driver
 * had taken it away — and the order line went on printing "2 damaged here" against a returned hire.
 *
 * DERIVED, NOT EVENT-DRIVEN, and that is the whole design. A collection note cannot tell us which
 * damaged units went back: its own `damagedQuantity` is capped against units NEVER reported (see
 * createRentalReturn), because a unit already on a report keeps its charge there — so there is no flag
 * to read. What we do know is arithmetic: the shelf cannot hold more damaged units than it holds units.
 *
 *     open damage held  ≤  hireAtWarehouse(line)
 *
 * Everything above that line demonstrably left. That is exactly the clamp every screen already applies
 * when it reads these numbers; the difference is that a clamp HIDES the drift and this RECORDS it.
 *
 * Idempotent and reversible, because it partitions rather than decrements: run it again on the same
 * shelf and nothing moves, run it after a reversed collection — where the shelf grows again — and the
 * records come back to `held_damaged` on their own. A decrementing version would need to know what it
 * had already done.
 *
 * OLDEST GOES FIRST when only some of them can have gone, matching `settleOpenAgainstNoteTx`. Which
 * physical unit went back is genuinely unknowable and every ordering is a guess; what matters is that
 * the guess is the same one twice, or a second run would shuffle the records for no reason.
 *
 * Only RETURNS move the shelf, so only they need this. A loss is always drained from an engineer's
 * holding (see declareHireLost), which lowers `issuedQuantity` and `lostQuantity` together and leaves
 * `hireAtWarehouse` exactly where it was — a lost unit was never on the shelf to begin with.
 */
export async function reconcileDamageCustodyTx(tx: Prisma.TransactionClient, lineId: string): Promise<void> {
  const line = await tx.purchaseOrderRentalLine.findUnique({
    where: { id: lineId },
    select: { receivedQuantity: true, returnedQuantity: true, lostQuantity: true, issuedQuantity: true },
  });
  if (!line) return;
  const shelf = Math.max(0, hireAtWarehouse(line));

  const rows = await tx.hireCustodyExit.findMany({
    where: {
      purchaseOrderRentalLineId: lineId,
      kind: "damage",
      // Both directions of the same partition. Reading only the held ones would make this one-way: a
      // reversed collection could never bring a record back.
      custodyState: { in: [CUSTODY_HELD_DAMAGED, CUSTODY_RETURNED_TO_SUPPLIER] },
    },
    // `id` breaks the tie, and it has to: a split shares its parent's `declaredAt` exactly, so on
    // date alone their order would be whatever Mongo felt like and the partition would not be stable.
    orderBy: [{ declaredAt: "asc" }, { id: "asc" }],
  });

  // ALREADY-GONE RECORDS ARE SPENT FIRST, and this is what makes a re-run a no-op rather than a
  // reshuffle. Ordered by date alone, a second run walks the surviving HELD remainder before the slice
  // its own first run sent back, spends the budget on the remainder, and splits the slice again — the
  // totals stay right while the rows churn, growing a new record on every collection.
  //
  // Sorted here rather than in the query: making it an `orderBy` would mean relying on
  // "returned_to_supplier" sorting after "held_damaged" alphabetically, which is true and is an
  // accident of the two words rather than a rule anybody chose.
  const ordered = [
    ...rows.filter((r) => r.custodyState === CUSTODY_RETURNED_TO_SUPPLIER),
    ...rows.filter((r) => r.custodyState !== CUSTODY_RETURNED_TO_SUPPLIER),
  ];

  const total = rows.reduce((n, r) => n + r.qty, 0);
  let gone = Math.max(0, total - shelf);

  for (const row of ordered) {
    if (gone >= row.qty) {
      if (row.custodyState !== CUSTODY_RETURNED_TO_SUPPLIER) {
        await moveCustodyStateTx(tx, row.id, row.custodyState, CUSTODY_RETURNED_TO_SUPPLIER);
      }
      gone -= row.qty;
      continue;
    }
    if (gone > 0) {
      // PART of this record went back. Split it: the parent keeps what is still here, and the slice
      // that left becomes its own record so each can be charged, withdrawn and read on its own terms.
      const slice = gone;
      const reduced = await tx.hireCustodyExit.updateMany({
        where: { id: row.id, qty: row.qty },
        data: { qty: row.qty - slice, custodyState: CUSTODY_HELD_DAMAGED },
      });
      // Lost the race to another writer on the same row; the next run partitions what it finds.
      if (reduced.count !== 1) continue;
      // A parent can be split MORE THAN ONCE — successive partial returns each take a slice — so the
      // key carries which slice this is. `sourceId` alone collides on the second one, and the unique
      // index would then abort a collection that had already committed its quantities.
      const n = await tx.hireCustodyExit.count({ where: { sourceId: row.id } });
      await tx.hireCustodyExit.create({
        data: {
          purchaseOrderRentalLineId: row.purchaseOrderRentalLineId,
          purchaseOrderId: row.purchaseOrderId,
          poCode: row.poCode,
          warehouseId: row.warehouseId,
          kind: row.kind,
          qty: slice,
          itemName: row.itemName,
          custodyState: CUSTODY_RETURNED_TO_SUPPLIER,
          // The MONEY follows the units it was agreed for. A slice off an already-settled record is
          // still settled — the charge was for those units and going back does not refund it.
          settlementState: row.settlementState,
          settledByReceiptId: row.settledByReceiptId,
          settledAt: row.settledAt,
          reason: row.reason,
          notes: row.notes,
          photoUrl: row.photoUrl,
          jobId: row.jobId,
          jobNumber: row.jobNumber,
          engineerId: row.engineerId,
          engineerName: row.engineerName,
          movementLineId: row.movementLineId,
          declaredBy: row.declaredBy,
          declaredAt: row.declaredAt,
          sourceType: `${CUSTODY_SPLIT}_${n}`,
          sourceId: row.id,
        },
      });
      gone = 0;
      continue;
    }
    // Still here — and possibly back here, if a collection was reversed.
    if (row.custodyState !== CUSTODY_HELD_DAMAGED) {
      await moveCustodyStateTx(tx, row.id, row.custodyState, CUSTODY_HELD_DAMAGED);
    }
  }

  await recomputeCountersTx(tx, lineId);
}

/** Everything a note CREATED — what its reversal has to withdraw outright. */
export function findBySourceTx(tx: Prisma.TransactionClient, sourceId: string): Promise<HireCustodyExit[]> {
  return tx.hireCustodyExit.findMany({ where: { sourceId } });
}

/** Everything settled by one note — what a reversal has to reopen. */
export function findByReceiptTx(tx: Prisma.TransactionClient, receiptId: string): Promise<HireCustodyExit[]> {
  return tx.hireCustodyExit.findMany({ where: { settledByReceiptId: receiptId } });
}

export function findByIdTx(tx: Prisma.TransactionClient, id: string): Promise<HireCustodyExit | null> {
  return tx.hireCustodyExit.findUnique({ where: { id } });
}

export function findById(id: string): Promise<HireCustodyExit | null> {
  return prisma.hireCustodyExit.findUnique({ where: { id } });
}

