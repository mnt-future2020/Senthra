/**
 * Hired equipment that is not coming back — declaring it lost, and booking it in if it turns up.
 *
 * ── Why this exists ────────────────────────────────────────────────────────────────────────────
 *
 * Every other exit a hire has was already modelled: it goes back to the provider (a return note), it
 * never arrived (close short), it broke (a damage note). The one thing missing was the ordinary,
 * unglamorous case — the engineer lost it. A van is broken into, a site is cleared, someone leaves the
 * company holding a tester.
 *
 * With no path for it the system sealed itself shut. Custody could only be drained by a job scan, and
 * there was nothing to scan. The supplier-return path refuses units that are out with an engineer.
 * Close-short only covers units that never arrived. So the hire could never reach a terminal state, its
 * order could be neither closed nor cancelled, and the job could never reconcile — one lost tester
 * parked a job, a hire and a purchase order open for ever, with the hire on the overdue badge and no
 * action anywhere that could clear it.
 *
 * ── Two facts, two lifecycles ──────────────────────────────────────────────────────────────────
 *
 * Declaring a loss is a statement about WHERE THE EQUIPMENT IS. Settling it is a statement about WHAT
 * WE OWE. They move at different times, are decided by different people, and this module only ever
 * writes the first: it drains custody and opens an exit row, and the office settles the provider's
 * charge on that row later through the existing damage/loss note. A credit note reversing that charge
 * does NOT find a missing tester, which is exactly why `custodyState` and `settlementState` are
 * separate columns rather than one status.
 *
 * Recovery is its own action for the same reason. It is not the "reversal" of anything financial — it
 * is the equipment turning up, and it restores custody while leaving both the original declaration and
 * whatever was settled on it standing as history.
 */

import type { Prisma } from "@prisma/client";

import { withTransaction } from "../../lib/prisma.js";
import { conflict, badRequest, notFound } from "../../utils/http-error.js";
import * as audit from "#modules/audit/audit.service.js";
import type { AuditActor } from "#modules/audit/audit.service.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as poRepo from "./purchase-order.repository.js";
import * as custodyExitRepo from "./hireCustodyExit.repository.js";
import * as receiptRepo from "#modules/rental-receipt/rental-receipt.repository.js";
import { emitHireUpdated } from "./rentalHire.realtime.js";
import { assertWarehouseAccess, warehouseScopeFilter } from "../../lib/warehouse-access.js";

export interface DeclareHireLostInput {
  purchaseOrderRentalLineId: string;
  engineerId: string;
  quantity: number;
  reason: string;
  notes?: string | null;
  jobId?: string | null;
  jobNumber?: string | null;
  engineerName?: string | null;
}

export interface RecoverHireLossInput {
  exitId: string;
  quantity: number;
  notes?: string | null;
}

export interface HireLossResult {
  exitId: string;
  lostQuantity: number;
  issuedQuantity: number;
}

/**
 * Declare units of a hire lost while they were out with an engineer.
 *
 * The unit moves from the ISSUED bucket to the LOST bucket — `received` and `returned` are historical
 * facts and neither changes, so the invariant `received = returned + lost + issued + onShelf` still
 * balances and the shelf count is untouched. That is the whole reason `lostQuantity` is a bucket
 * rather than a flag: nothing is deducted twice no matter which of the three availability figures the
 * caller goes on to read.
 *
 * Deliberately does NOT touch `returnedQuantity`. The provider never got these units back; recording
 * them as returned would tell the collection record a lie and quietly close the hire's liability.
 */
export async function declareHireLost(input: DeclareHireLostInput, actor?: AuditActor): Promise<HireLossResult> {
  if (input.quantity <= 0) throw badRequest("Enter how many units are lost.");
  if (!input.reason?.trim()) throw badRequest("Select why this hired equipment is being declared lost.");

  const hire = await poRepo.findHireStockById(input.purchaseOrderRentalLineId);
  if (!hire) throw notFound("That hire no longer exists.");
  // Scoped on the hire's own depot, exactly as every other hire action is (`loadOrThrow` in
  // purchase-order.service). A manager reaches only their own sites' hires.
  assertWarehouseAccess(actor, hire.warehouseId);

  const actorEmail = actor?.email ?? null;
  let exitId = "";
  let lostQuantity = 0;
  let issuedQuantity = 0;

  await withTransaction(async (tx) => {
    // The engineer must actually be holding what is being written off. Read INSIDE the transaction so
    // a return landing a moment ago is seen — otherwise a lost declaration could drain custody that
    // has already come home, and the units would be counted lost while standing on the shelf.
    const held = await rentalCustodyRepo.findRentalHoldingTx(tx, hire.id, input.engineerId);
    if (!held || held.quantityOnHand < input.quantity) {
      throw conflict(
        `That engineer is holding ${held?.quantityOnHand ?? 0} of this hire, not ${input.quantity}. Refresh and check what is still out.`,
      );
    }

    // COMPARE-AND-SET on the quantity we just read, which is what makes two people declaring the same
    // tester lost at the same moment resolve to one write. `upsertRentalHoldingTx` is a blind
    // increment — correct for a scan, where two scans really are two events, but wrong here: a
    // double-submitted declaration is one event and must not drain custody twice. The loser gets a 409
    // telling them the numbers moved, which is the same answer every other guard in this module gives.
    const drained = await tx.engineerRentalHolding.updateMany({
      where: { id: held.id, quantityOnHand: held.quantityOnHand },
      data: { quantityOnHand: held.quantityOnHand - input.quantity },
    });
    if (drained.count !== 1) {
      throw conflict("This engineer's holding changed while the loss was being recorded. Refresh and check what is still out.");
    }
    const ledgerRow = await rentalCustodyRepo.insertRentalTxnTx(tx, {
      purchaseOrderRentalLineId: hire.id,
      engineerId: input.engineerId,
      quantityDelta: -input.quantity,
      type: "job_lost",
      sourceType: "hire_loss",
      sourceId: hire.id,
      sourceCode: hire.poCode,
      balanceAfter: held.quantityOnHand - input.quantity,
      notes: input.reason,
      createdBy: actorEmail,
    });
    const ledgerRowId = ledgerRow.id;

    // Take the units out of ISSUED. The conditional guard refuses if the hire's numbers moved under
    // us, which is what stops two people declaring the same tester lost at once.
    const released = await poRepo.adjustHireIssuedQtyTx(tx, hire.id, -input.quantity);
    if (!released) throw conflict("This hire's numbers moved while the loss was being recorded. Refresh and try again.");

    // …and put them into LOST, via the row that carries the evidence. `createExitTx` recomputes
    // `lostQuantity` as an absolute from the live rows, so the counter can never drift from them.
    const exit = await custodyExitRepo.createExitTx(tx, {
      purchaseOrderRentalLineId: hire.id,
      purchaseOrderId: hire.purchaseOrderId,
      poCode: hire.poCode,
      warehouseId: hire.warehouseId,
      kind: "loss",
      qty: input.quantity,
      itemName: hire.itemName,
      custodyState: custodyExitRepo.CUSTODY_LOST,
      reason: input.reason,
      notes: input.notes ?? null,
      jobId: input.jobId ?? null,
      jobNumber: input.jobNumber ?? null,
      engineerId: input.engineerId,
      engineerName: input.engineerName ?? null,
      declaredBy: actorEmail,
      // Deliberately keyed on the LEDGER ROW this declaration just wrote, not on the job or the hire.
      // Two genuine losses off one hire on one job are two events and must both be recordable, so a
      // (job, hire) key would wrongly collapse them into one. Double-submit is stopped upstream by the
      // compare-and-set on the holding — a retry finds a quantity that no longer matches and is
      // refused before it reaches here.
      sourceType: "reconcile_loss",
      sourceId: ledgerRowId,
    });
    exitId = exit.id;

    const fresh = await poRepo.findHireStockByIdTx(tx, hire.id);
    lostQuantity = fresh?.lostQuantity ?? 0;
    issuedQuantity = fresh?.issuedQuantity ?? 0;
  });

  emitHireUpdated(hire.purchaseOrderId, hire.poCode ?? "");
  audit.record({
    actor,
    action: "rental_hire.declared_lost",
    targetType: "purchase_order",
    targetId: hire.purchaseOrderId,
    targetLabel: hire.poCode ?? hire.purchaseOrderId,
    // Everything anyone auditing a write-off of somebody else's equipment needs on one line: how many,
    // of what, who was holding it, on which job, and why.
    metadata: {
      item: hire.itemName,
      quantity: input.quantity,
      reason: input.reason,
      engineerId: input.engineerId,
      engineerName: input.engineerName ?? null,
      jobNumber: input.jobNumber ?? null,
      changes: [
        {
          label:
            `${hire.itemName}: ${input.quantity} declared lost` +
            (input.engineerName ? ` (held by ${input.engineerName})` : "") +
            (input.jobNumber ? ` on ${input.jobNumber}` : "") +
            ` — ${input.reason}`,
        },
      ],
    },
  });

  return { exitId, lostQuantity, issuedQuantity };
}

/**
 * The equipment turned up. Book it back onto the shelf.
 *
 * Restores custody ONLY. Whatever the provider was told, quoted or charged stays exactly where it is —
 * a recovered tester may still carry a settled replacement charge, and what to do about that is an
 * accounting decision this module deliberately does not make. Keeping the two apart is what lets that
 * decision be taken later without unpicking custody.
 *
 * A PARTIAL recovery splits the row rather than editing it: the original declaration keeps standing for
 * what is still missing, and a second row records what came back. Reducing the original in place would
 * quietly rewrite what was declared, and the declaration is the document somebody signed.
 */
export async function recoverHireLoss(input: RecoverHireLossInput, actor?: AuditActor): Promise<HireLossResult> {
  if (input.quantity <= 0) throw badRequest("Enter how many units have been found.");

  const exit = await custodyExitRepo.findById(input.exitId);
  if (!exit) throw notFound("That loss record no longer exists.");
  if (exit.kind !== "loss") throw badRequest("That record is not a loss declaration.");
  assertWarehouseAccess(actor, exit.warehouseId);
  if (exit.custodyState !== custodyExitRepo.CUSTODY_LOST) throw conflict("Those units have already been booked back in.");
  if (input.quantity > exit.qty) throw badRequest(`Only ${exit.qty} unit${exit.qty === 1 ? " is" : "s are"} recorded lost on this declaration.`);

  const actorEmail = actor?.email ?? null;
  const now = new Date();
  let lostQuantity = 0;
  let issuedQuantity = 0;

  await withTransaction(async (tx) => {
    const recoveryFields: Prisma.HireCustodyExitUncheckedUpdateInput = {
      recoveredBy: actorEmail,
      recoveredAt: now,
      recoveryNotes: input.notes ?? null,
    };

    if (input.quantity === exit.qty) {
      // Conditional on the state it moves FROM, so two people booking in the same find cannot both
      // succeed and credit the units twice.
      const moved = await custodyExitRepo.moveCustodyStateTx(tx, exit.id, custodyExitRepo.CUSTODY_LOST, custodyExitRepo.CUSTODY_RECOVERED, recoveryFields);
      if (!moved) throw conflict("Those units have already been booked back in. Refresh and check.");
    } else {
      const remaining = exit.qty - input.quantity;
      const reduced = await tx.hireCustodyExit.updateMany({
        where: { id: exit.id, custodyState: custodyExitRepo.CUSTODY_LOST, qty: exit.qty },
        data: { qty: remaining },
      });
      if (reduced.count !== 1) throw conflict("This loss record changed while the recovery was being saved. Refresh and try again.");
      const recoveries = await tx.hireCustodyExit.count({ where: { sourceId: exit.id } });
      await tx.hireCustodyExit.create({
        data: {
          purchaseOrderRentalLineId: exit.purchaseOrderRentalLineId,
          purchaseOrderId: exit.purchaseOrderId,
          poCode: exit.poCode,
          warehouseId: exit.warehouseId,
          kind: "loss",
          qty: input.quantity,
          itemName: exit.itemName,
          custodyState: custodyExitRepo.CUSTODY_RECOVERED,
          // A recovered unit owes the provider nothing, so it leaves the settle worklist immediately —
          // it never had a charge of its own, and the declaration it was split from keeps whatever the
          // office had already agreed for the units still missing.
          settlementState: custodyExitRepo.SETTLE_DISMISSED,
          reason: exit.reason,
          notes: input.notes ?? null,
          jobId: exit.jobId,
          jobNumber: exit.jobNumber,
          engineerId: exit.engineerId,
          engineerName: exit.engineerName,
          declaredBy: exit.declaredBy,
          declaredAt: exit.declaredAt,
          recoveredBy: actorEmail,
          recoveredAt: now,
          recoveryNotes: input.notes ?? null,
          // Numbered, because one declaration can be recovered in PARTS — two of five turn up today
          // and the rest next week. A constant key repeats on the second recovery, and the unique
          // index refuses it as a raw P2002 rather than anything the caller can read.
          sourceType: `loss_recovery_${recoveries}`,
          sourceId: exit.id,
        },
      });
    }

    // Counters last, from the live rows — the same absolute recompute every writer here uses.
    const counters = await custodyExitRepo.recomputeCountersTx(tx, exit.purchaseOrderRentalLineId);
    lostQuantity = counters.lostQuantity;
    const fresh = await poRepo.findHireStockByIdTx(tx, exit.purchaseOrderRentalLineId);
    issuedQuantity = fresh?.issuedQuantity ?? 0;
  });

  emitHireUpdated(exit.purchaseOrderId, exit.poCode ?? "");
  audit.record({
    actor,
    action: "rental_hire.loss_recovered",
    targetType: "purchase_order",
    targetId: exit.purchaseOrderId,
    targetLabel: exit.poCode ?? exit.purchaseOrderId,
    metadata: {
      quantity: input.quantity,
      // Named explicitly because it is the question an auditor asks first when a written-off asset
      // reappears: was anyone already charged for this?
      settlementStateAtRecovery: exit.settlementState,
      changes: [
        {
          label:
            `${input.quantity} unit${input.quantity === 1 ? "" : "s"} previously declared lost ${input.quantity === 1 ? "was" : "were"} found and booked back in` +
            (exit.settlementState === custodyExitRepo.SETTLE_SETTLED ? " — a supplier charge had already been settled against this declaration" : ""),
        },
      ],
    },
  });

  return { exitId: exit.id, lostQuantity, issuedQuantity };
}

// ── Reading the record back ─────────────────────────────────────────────────────────────────────
//
// The write side of this module was complete and every screen was blind to it: a tester was declared
// lost, the arithmetic moved, and the order page still read "100 ordered · on hire" with nothing
// anywhere saying a unit was gone, who lost it or why. Recording a fact nobody can read is barely
// better than not recording it — the reason lives in the row, not in somebody's memory of the day.

export interface PublicCustodyExit {
  id: string;
  purchaseOrderRentalLineId: string;
  purchaseOrderId: string;
  poCode: string | null;
  warehouseId: string;
  kind: "damage" | "loss";
  qty: number;
  custodyState: string;
  settlementState: string;
  reason: string;
  notes: string | null;
  photoUrl: string | null;
  jobId: string | null;
  jobNumber: string | null;
  engineerId: string | null;
  engineerName: string | null;
  declaredBy: string | null;
  declaredAt: string;
  settledByReceiptId: string | null;
  settledAt: string | null;
  recoveredBy: string | null;
  recoveredAt: string | null;
  recoveryNotes: string | null;
  /**
   * The note that settled this, identified — so a row can read "£90 · HLS-0002" without fetching it.
   *
   * `settledCharge` is null when the note carries no figure on any line: nothing has been quoted yet,
   * which is a different fact from a charge of zero and must not be flattened into one.
   */
  settledByCode: string | null;
  settledCharge: number | null;
  /**
   * The NOTE this record was raised from, when that note is a warehouse damage report.
   *
   * Two different undos hang off a record and they are not interchangeable: withdrawing the REPORT
   * says the damage never happened, and withdrawing the CHARGE says the money was wrong while the
   * tester stays broken. Each is a reversal of a different note, so the record has to name both.
   *
   * Null for damage found on a job: its source is a movement on the return, not a note anybody can
   * reverse — an engineer's report is undone by correcting the return itself.
   */
  sourceReceiptId: string | null;
  sourceCode: string | null;
  /**
   * Files on the note this record is tied to — the photographs a WAREHOUSE report carries.
   *
   * Damage found on a job stores its picture on the record itself (`photoUrl`), because the engineer
   * took it at the moment they saw the fault. Damage found here is filed on a form, and its pictures
   * are uploaded as attachments to the note that form creates. Both are the same evidence to whoever
   * ends up arguing the charge, so both reach the record — otherwise half of it is visible only if a
   * note happens to be listed on the page.
   */
  attachments: receiptRepo.NoteFile[];
  /** The note those files belong to — what a removal has to be addressed to. */
  attachmentsReceiptId: string | null;
}

function toPublicExit(
  e: {
  id: string; purchaseOrderRentalLineId: string; purchaseOrderId: string; poCode: string | null; warehouseId: string;
  kind: string; qty: number; custodyState: string; settlementState: string; reason: string; notes: string | null;
  photoUrl: string | null; jobId: string | null; jobNumber: string | null; engineerId: string | null;
  engineerName: string | null; declaredBy: string | null; declaredAt: Date; settledByReceiptId: string | null;
  settledAt: Date | null; recoveredBy: string | null; recoveredAt: Date | null; recoveryNotes: string | null;
  sourceId: string;
  },
  settlement?: { code: string; chargePence: number | null; attachments: receiptRepo.NoteFile[] },
  /** The note this record was RAISED from, when that is a different document from the one that settled it. */
  source?: { code: string; attachments: receiptRepo.NoteFile[] },
  attachmentsReceiptId?: string | null,
): PublicCustodyExit {
  return {
    ...e,
    kind: e.kind === "loss" ? "loss" : "damage",
    declaredAt: e.declaredAt.toISOString(),
    settledAt: e.settledAt?.toISOString() ?? null,
    recoveredAt: e.recoveredAt?.toISOString() ?? null,
    settledByCode: settlement?.code ?? null,
    // `source` is only ever passed for a warehouse report (see withSettlements), so its presence IS
    // the answer to "is there a note behind this record that somebody could withdraw?".
    sourceReceiptId: source ? e.sourceId : null,
    sourceCode: source?.code ?? null,
    // Pounds on the wire, like every other money field the client renders.
    settledCharge: settlement?.chargePence == null ? null : settlement.chargePence / 100,
    // Deduped by url: a warehouse report is BOTH the source and the settlement of its own record, so
    // its files would otherwise arrive twice.
    attachments: [...new Map([...(source?.attachments ?? []), ...(settlement?.attachments ?? [])].map((a) => [a.id, a])).values()],
    attachmentsReceiptId: attachmentsReceiptId ?? null,
  };
}

/**
 * Attach the note each settled record names, in ONE query for the whole set.
 *
 * Shared by every reader so a settled record identifies itself the same way wherever it is shown, and
 * so none of them resolves a note per row — that would be a round trip per row on a remote cluster.
 */
async function withSettlements(rows: Awaited<ReturnType<typeof custodyExitRepo.findByOrder>>): Promise<PublicCustodyExit[]> {
  // BOTH links, in one lookup: the note a record was settled on, and the note it was raised from. A
  // warehouse report is its own source, and its photographs live there rather than on the record.
  // `sourceId` is only a receipt when the source says so — for a job return it is a movement id, and
  // asking for it would simply miss.
  const notes = await receiptRepo.findSettlementSummaries([
    ...new Set([
      ...rows.map((r) => r.settledByReceiptId).filter((v): v is string => Boolean(v)),
      ...rows.filter((r) => r.sourceType === "warehouse_damage_note").map((r) => r.sourceId),
    ]),
  ]);
  return rows.map((r) =>
    toPublicExit(
      r,
      r.settledByReceiptId ? notes.get(r.settledByReceiptId) : undefined,
      r.sourceType === "warehouse_damage_note" ? notes.get(r.sourceId) : undefined,
      // Files live on ONE note — the report that raised the record, or failing that the one that
      // settled it — and a removal has to name it.
      r.sourceType === "warehouse_damage_note" ? r.sourceId : r.settledByReceiptId,
    ),
  );
}

/** Every custody exit on one order — the order page's timeline, beside its delivery and return notes. */
export async function listOrderCustodyExits(purchaseOrderId: string, actor?: AuditActor): Promise<PublicCustodyExit[]> {
  const rows = await custodyExitRepo.findByOrder(purchaseOrderId);
  // Scoped on the ORDER's depot, like every other read on this page: one query, one check, and a
  // manager reaches only their own sites. Reading the rows first is safe — nothing is returned until
  // the check passes, and an order with no exits has nothing to leak either way.
  if (rows[0]) assertWarehouseAccess(actor, rows[0].warehouseId);
  return withSettlements(rows);
}

/**
 * Every custody exit on ONE hire line — the damaged pane's History drill-down for a rental row.
 *
 * The owned pool answers History by walking its damaged-stock ledger; a hire has no row in that ledger
 * by design, and sending the user off to the order page instead made one row in the list behave unlike
 * every other. Same question, same modal, different source.
 *
 * Unfiltered by settlement or custody state: "show me everything that ever happened to this hire" is
 * what History means on the rows beside it, and a withdrawn report or a recovered loss is exactly what
 * somebody asking it needs to see.
 */
export async function listHireCustodyHistory(purchaseOrderRentalLineId: string, actor?: AuditActor): Promise<PublicCustodyExit[]> {
  const rows = await custodyExitRepo.findByHireLines([purchaseOrderRentalLineId]);
  if (rows[0]) assertWarehouseAccess(actor, rows[0].warehouseId);
  return withSettlements(rows);
}

/**
 * Open rental damage or loss — the damaged pane's rental rows.
 *
 * TWO DIFFERENT QUESTIONS, and confusing them was a data leak. "Which warehouses may this person see"
 * is the permission scope; "which warehouse am I looking at" is the pane. This read had only the first,
 * so a super admin standing on one depot's Damaged tab was shown every depot's hired damage beside
 * that depot's own owned stock — five rows of it, from three other sites.
 *
 * `warehouseId` narrows to the pane and is checked against the scope first, exactly as the owned pool's
 * `listDamaged` does. Omitting it keeps the old meaning (everything in scope), which is what a
 * company-wide screen wants.
 *
 * `undefined` scope means an unrestricted actor and is passed straight through: a filter of "no
 * warehouses" and a filter of "every warehouse" must not be the same value, or an admin sees nothing.
 */
export async function listOpenCustodyExits(
  filter: { warehouseId?: string; kind?: custodyExitRepo.ExitKind },
  actor?: AuditActor,
): Promise<PublicCustodyExit[]> {
  const scopeIds = warehouseScopeFilter(actor);
  if (filter.warehouseId) {
    // Refused before it is read, not filtered afterwards — the answer to "may I see this depot" is a
    // 403, not an empty list.
    assertWarehouseAccess(actor, filter.warehouseId);
    return withSettlements(await custodyExitRepo.findOpenByWarehouses([filter.warehouseId], filter.kind));
  }
  return withSettlements(await custodyExitRepo.findOpenByWarehouses(scopeIds, filter.kind));
}
