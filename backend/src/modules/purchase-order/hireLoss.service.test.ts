import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma.js", () => ({
  prisma: {},
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txStub)),
}));
vi.mock("../../lib/warehouse-access.js", () => ({ assertWarehouseAccess: vi.fn(), warehouseScopeFilter: vi.fn(() => undefined) }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("./rentalHire.realtime.js", () => ({ emitHireUpdated: vi.fn() }));
vi.mock("./purchase-order.repository.js", () => ({
  findHireStockById: vi.fn(),
  findHireStockByIdTx: vi.fn(async () => ({ lostQuantity: 1, issuedQuantity: 1 })),
  adjustHireIssuedQtyTx: vi.fn(async () => true),
}));
vi.mock("#modules/engineer-rental/engineer-rental.repository.js", () => ({
  findRentalHoldingTx: vi.fn(),
  insertRentalTxnTx: vi.fn(async () => ({ id: "t".repeat(24) })),
  upsertRentalHoldingTx: vi.fn(),
}));
vi.mock("./hireCustodyExit.repository.js", () => ({
  createExitTx: vi.fn(async () => ({ id: "x".repeat(24) })),
  findById: vi.fn(),
  findByOrder: vi.fn(async () => []),
  findOpenByWarehouses: vi.fn(async () => []),
  moveCustodyStateTx: vi.fn(async () => true),
  moveSettlementStateTx: vi.fn(async () => true),
  recomputeCountersTx: vi.fn(async () => ({ fieldDamageQty: 0, lostQuantity: 0 })),
  CUSTODY_LOST: "lost",
  CUSTODY_RECOVERED: "recovered",
  CUSTODY_HELD_DAMAGED: "held_damaged",
  CUSTODY_RETURNED_TO_SUPPLIER: "returned_to_supplier",
  CUSTODY_WITHDRAWN: "withdrawn",
  SETTLE_UNSETTLED: "unsettled",
  SETTLE_SETTLED: "settled",
  SETTLE_DISMISSED: "dismissed",
}));

const txStub = {
  engineerRentalHolding: { updateMany: vi.fn(async () => ({ count: 1 })) },
  hireCustodyExit: {
    updateMany: vi.fn(async () => ({ count: 1 })),
    // A partial recovery numbers its slice off this count — one declaration can be recovered in
    // parts, and a constant key would repeat on the second.
    count: vi.fn(async () => 1),
    create: vi.fn(async () => ({ id: "y".repeat(24) })),
  },
};

import * as audit from "#modules/audit/audit.service.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as custodyExitRepo from "./hireCustodyExit.repository.js";
import * as poRepo from "./purchase-order.repository.js";
import { assertWarehouseAccess } from "../../lib/warehouse-access.js";
import { declareHireLost, dismissCustodyExit, listOpenCustodyExits, listOrderCustodyExits, recoverHireLoss } from "./hireLoss.service.js";

const HIRE_ID = "e".repeat(24);
const ENG_ID = "c".repeat(24);
const PO_ID = "9".repeat(24);
const WH_ID = "b".repeat(24);

const hire = (over: Record<string, unknown> = {}) => ({
  id: HIRE_ID,
  itemName: "Fibre Tester",
  purchaseOrderId: PO_ID,
  poCode: "PO-0042",
  warehouseId: WH_ID,
  receivedQuantity: 3,
  returnedQuantity: 0,
  issuedQuantity: 2,
  lostQuantity: 0,
  fieldDamageQty: 0,
  ...over,
});

const holding = (over: Record<string, unknown> = {}) => ({
  id: "h".repeat(24),
  quantityOnHand: 2,
  rentalItemId: "d".repeat(24),
  itemName: "Fibre Tester",
  poCode: "PO-0042",
  hireEndDate: new Date("2026-09-14T00:00:00Z"),
  ...over,
});

const declare = (over: Record<string, unknown> = {}) =>
  declareHireLost(
    { purchaseOrderRentalLineId: HIRE_ID, engineerId: ENG_ID, quantity: 1, reason: "site_theft", jobId: "a".repeat(24), jobNumber: "JOB-2026-0117", engineerName: "Dave", ...over },
    { email: "wm@x.co" } as never,
  );

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(poRepo.findHireStockById).mockResolvedValue(hire() as never);
  vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue({ lostQuantity: 1, issuedQuantity: 1 } as never);
  vi.mocked(poRepo.adjustHireIssuedQtyTx).mockResolvedValue(true);
  vi.mocked(rentalCustodyRepo.findRentalHoldingTx).mockResolvedValue(holding() as never);
  txStub.engineerRentalHolding.updateMany.mockResolvedValue({ count: 1 } as never);
  txStub.hireCustodyExit.updateMany.mockResolvedValue({ count: 1 } as never);
});

describe("declareHireLost — custody leaves, the provider's claim does not", () => {
  it("moves the units from ISSUED into LOST and touches nothing else", async () => {
    await declare();
    // Out of the van…
    expect(poRepo.adjustHireIssuedQtyTx).toHaveBeenCalledWith(expect.anything(), HIRE_ID, -1);
    // …and into the lost bucket, via the row that carries the evidence.
    expect(custodyExitRepo.createExitTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "loss", qty: 1, custodyState: "lost", reason: "site_theft", engineerId: ENG_ID }),
    );
  });

  it("never records the units as RETURNED to the provider", async () => {
    // They never got them back. Writing this into `returnedQuantity` would close the hire's liability
    // on a lie and take it off the badge that is still chasing the charge.
    await declare();
    for (const call of vi.mocked(poRepo.adjustHireIssuedQtyTx).mock.calls) expect(call[2]).toBeLessThan(0);
    expect(txStub.hireCustodyExit.create).not.toHaveBeenCalled();
  });

  it("refuses when the engineer is not holding that many", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingTx).mockResolvedValue(holding({ quantityOnHand: 0 }) as never);
    await expect(declare()).rejects.toThrow(/holding 0 of this hire/i);
  });

  it("refuses a second declaration whose holding moved under it", async () => {
    // The compare-and-set. Two people declaring the same tester lost at once both read 2; only one
    // update matches, and the loser is told the numbers moved rather than draining custody twice.
    txStub.engineerRentalHolding.updateMany.mockResolvedValue({ count: 0 } as never);
    await expect(declare()).rejects.toThrow(/holding changed|Refresh/i);
  });

  it("refuses when the hire's own numbers moved mid-write", async () => {
    vi.mocked(poRepo.adjustHireIssuedQtyTx).mockResolvedValue(false);
    await expect(declare()).rejects.toThrow(/numbers moved/i);
  });

  it("audits who lost it, on what job, and why", async () => {
    await declare();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rental_hire.declared_lost",
        metadata: expect.objectContaining({ quantity: 1, reason: "site_theft", engineerId: ENG_ID, jobNumber: "JOB-2026-0117" }),
      }),
    );
  });

  it("rejects an empty reason and a non-positive quantity before touching anything", async () => {
    await expect(declare({ quantity: 0 })).rejects.toThrow(/how many units/i);
    await expect(declare({ reason: "  " })).rejects.toThrow(/why this hired equipment/i);
    expect(poRepo.adjustHireIssuedQtyTx).not.toHaveBeenCalled();
  });
});

describe("recoverHireLoss — the equipment turned up", () => {
  const exit = (over: Record<string, unknown> = {}) => ({
    id: "x".repeat(24),
    kind: "loss",
    qty: 2,
    custodyState: "lost",
    settlementState: "unsettled",
    purchaseOrderRentalLineId: HIRE_ID,
    purchaseOrderId: PO_ID,
    poCode: "PO-0042",
    warehouseId: WH_ID,
    reason: "site_theft",
    jobId: null,
    jobNumber: null,
    engineerId: ENG_ID,
    engineerName: "Dave",
    declaredBy: "wm@x.co",
    declaredAt: new Date("2026-08-01T00:00:00Z"),
    ...over,
  });

  it("moves the whole declaration to recovered when everything is found", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit() as never);
    await recoverHireLoss({ exitId: "x".repeat(24), quantity: 2 }, { email: "wm@x.co" } as never);
    expect(custodyExitRepo.moveCustodyStateTx).toHaveBeenCalledWith(expect.anything(), "x".repeat(24), "lost", "recovered", expect.anything());
  });

  it("splits the row on a partial find so the declaration still stands for what is missing", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit() as never);
    await recoverHireLoss({ exitId: "x".repeat(24), quantity: 1 }, { email: "wm@x.co" } as never);
    // The original is reduced to what is STILL lost, conditionally on the quantity just read…
    expect(txStub.hireCustodyExit.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { qty: 1 } }));
    // …and the unit that came back gets a row of its own rather than editing history.
    expect(txStub.hireCustodyExit.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ qty: 1, custodyState: "recovered" }) }),
    );
  });

  it("refuses to book the same find in twice", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit({ custodyState: "recovered" }) as never);
    await expect(recoverHireLoss({ exitId: "x".repeat(24), quantity: 2 }, {} as never)).rejects.toThrow(/already been booked back in/i);
  });

  it("refuses to recover more than was declared lost", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit() as never);
    await expect(recoverHireLoss({ exitId: "x".repeat(24), quantity: 5 }, {} as never)).rejects.toThrow(/Only 2 units are recorded lost/i);
  });

  it("recovers custody without touching a settlement that has already been agreed", async () => {
    // A charge already settled stays settled — what to do about a replacement we paid for and then
    // found is an accounting decision, not a custody one, and this module deliberately does not make
    // it. The audit line flags it so nobody has to notice on their own.
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit({ settlementState: "settled" }) as never);
    await recoverHireLoss({ exitId: "x".repeat(24), quantity: 2 }, { email: "wm@x.co" } as never);
    const call = vi.mocked(custodyExitRepo.moveCustodyStateTx).mock.calls[0];
    expect(call[2]).toBe("lost");
    expect(call[3]).toBe("recovered");
    // Nothing in the update touches settlementState.
    expect(JSON.stringify(call[4])).not.toMatch(/settlementState/);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ settlementStateAtRecovery: "settled" }) }),
    );
  });

  it("refuses a record that is not a loss declaration", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit({ kind: "damage" }) as never);
    await expect(recoverHireLoss({ exitId: "x".repeat(24), quantity: 1 }, {} as never)).rejects.toThrow(/not a loss declaration/i);
  });
});

// ── Reading the record back ────────────────────────────────────────────────────────────────────
//
// The whole write side of this module worked and every screen was blind to it: a tester was declared
// lost, the arithmetic moved, and the order page still read "100 ordered · on hire" with nothing saying
// a unit was gone, who lost it or why. These pin the read side so it cannot silently disappear again.
describe("listOrderCustodyExits", () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: "x".repeat(24),
    purchaseOrderRentalLineId: HIRE_ID,
    purchaseOrderId: PO_ID,
    poCode: "PO-0042",
    warehouseId: WH_ID,
    kind: "loss",
    qty: 2,
    custodyState: "lost",
    settlementState: "unsettled",
    reason: "site_theft",
    notes: null,
    photoUrl: null,
    jobId: "j1",
    jobNumber: "JOB-2026-0117",
    engineerId: ENG_ID,
    engineerName: "Dave",
    declaredBy: "wm@x.co",
    declaredAt: new Date("2026-08-01T00:00:00Z"),
    settledByReceiptId: null,
    settledAt: null,
    recoveredBy: null,
    recoveredAt: null,
    recoveryNotes: null,
    ...over,
  });

  it("hands back the WHO and the WHY, not just a quantity", async () => {
    vi.mocked(custodyExitRepo.findByOrder).mockResolvedValue([row()] as never);
    const [out] = await listOrderCustodyExits(PO_ID, { email: "pm@x.co" } as never);
    expect(out).toMatchObject({
      kind: "loss",
      qty: 2,
      reason: "site_theft",
      jobNumber: "JOB-2026-0117",
      engineerName: "Dave",
      declaredBy: "wm@x.co",
      settlementState: "unsettled",
    });
    // Dates leave as ISO, like every other date on a public shape.
    expect(out!.declaredAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("is warehouse-scoped on the order's own depot", async () => {
    vi.mocked(custodyExitRepo.findByOrder).mockResolvedValue([row()] as never);
    await listOrderCustodyExits(PO_ID, { email: "pm@x.co" } as never);
    expect(vi.mocked(assertWarehouseAccess)).toHaveBeenCalledWith(expect.anything(), WH_ID);
  });

  it("returns an empty list without pretending there was something to scope", async () => {
    vi.mocked(custodyExitRepo.findByOrder).mockResolvedValue([] as never);
    expect(await listOrderCustodyExits(PO_ID, {} as never)).toEqual([]);
  });
});

describe("listOpenCustodyExits", () => {
  it("narrows to the WAREHOUSE BEING VIEWED, not merely to what the actor may see", async () => {
    // THE LEAK THIS FIXES. An unrestricted actor standing on one depot's Damaged tab was shown every
    // depot's hired damage beside that depot's own owned stock — the owned rows were filtered by the
    // pane's warehouse and the hired ones only by the permission scope, which for an admin is nothing.
    vi.mocked(custodyExitRepo.findOpenByWarehouses).mockResolvedValue([] as never);
    await listOpenCustodyExits({ warehouseId: WH_ID }, { email: "admin@x.co" } as never);
    expect(vi.mocked(custodyExitRepo.findOpenByWarehouses)).toHaveBeenCalledWith([WH_ID], undefined);
  });

  it("checks the pane's warehouse against the actor's scope before reading it", async () => {
    // A 403, not an empty list: "may I see this depot" is a different answer from "this depot is clean".
    vi.mocked(custodyExitRepo.findOpenByWarehouses).mockResolvedValue([] as never);
    await listOpenCustodyExits({ warehouseId: WH_ID }, { email: "wm@x.co" } as never);
    expect(vi.mocked(assertWarehouseAccess)).toHaveBeenCalledWith(expect.anything(), WH_ID);
  });

  it("falls back to the whole permission scope when no warehouse is named", async () => {
    vi.mocked(custodyExitRepo.findOpenByWarehouses).mockResolvedValue([] as never);
    await listOpenCustodyExits({}, { email: "admin@x.co" } as never);
    // `undefined` is "every warehouse", not "no warehouses" — confusing the two makes an admin see
    // nothing, which is the failure mode every scoped read here is written to avoid.
    expect(vi.mocked(custodyExitRepo.findOpenByWarehouses)).toHaveBeenCalledWith(undefined, undefined);
    expect(vi.mocked(assertWarehouseAccess)).not.toHaveBeenCalled();
  });

  it("narrows to a kind when one is asked for", async () => {
    vi.mocked(custodyExitRepo.findOpenByWarehouses).mockResolvedValue([] as never);
    await listOpenCustodyExits({ warehouseId: WH_ID, kind: "damage" }, {} as never);
    expect(vi.mocked(custodyExitRepo.findOpenByWarehouses)).toHaveBeenCalledWith([WH_ID], "damage");
  });
});

// ── Dismissing a damage report ────────────────────────────────────────────────────────────────
//
// The third answer to a damage report, and the one a job-reported exit had no way to reach: the units
// really are broken and nobody is being billed. Everything here is about what dismissal must NOT do —
// it is a settlement-only write, and every assertion below pins one thing it must leave alone.

const damageExit = (over: Record<string, unknown> = {}) => ({
  id: "x".repeat(24),
  purchaseOrderRentalLineId: HIRE_ID,
  purchaseOrderId: PO_ID,
  poCode: "PO-0042",
  warehouseId: WH_ID,
  kind: "damage",
  qty: 2,
  itemName: "Fibre Tester",
  custodyState: "held_damaged",
  settlementState: "unsettled",
  reason: "Screen cracked in the van",
  notes: null,
  photoUrl: "https://cdn/x.jpg",
  jobId: "a".repeat(24),
  jobNumber: "JOB-2026-0117",
  engineerId: ENG_ID,
  engineerName: "Dave",
  // A job-reported exit — opened by a return MOVEMENT, so there is no note behind it to withdraw.
  // This is precisely the row that previously had no way off the worklist except a supplier charge.
  sourceType: "goods_management_return",
  sourceId: "m".repeat(24),
  settledByReceiptId: null,
  settledAt: null,
  ...over,
});

const dismiss = (over: Record<string, unknown> = {}, actor: unknown = { email: "pm@x.co" }) =>
  dismissCustodyExit({ exitId: "x".repeat(24), reason: "Fair wear over a six-month hire", ...over }, actor as never);

describe("dismissCustodyExit — the money stops, the equipment does not move", () => {
  beforeEach(() => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(damageExit() as never);
    vi.mocked(custodyExitRepo.moveSettlementStateTx).mockResolvedValue(true);
  });

  it("moves a job-reported damage report to dismissed, and writes nothing else", async () => {
    const res = await dismiss();

    expect(res).toEqual({ exitId: "x".repeat(24), settlementState: "dismissed", changed: true });
    // The ONE write. Conditional on `unsettled`, so a concurrent charge cannot be overwritten.
    expect(custodyExitRepo.moveSettlementStateTx).toHaveBeenCalledWith(
      expect.anything(),
      "x".repeat(24),
      "unsettled",
      "dismissed",
      // The decision date, and a null receipt — `settledByReceiptId` is what every reader uses to ask
      // "is there a document behind this", and a dismissal has none.
      expect.objectContaining({ settledAt: expect.any(Date) }),
    );
    expect(custodyExitRepo.moveSettlementStateTx).toHaveBeenCalledTimes(1);
  });

  it("creates NO supplier document — the whole point of the action", async () => {
    await dismiss();
    // A charge raises an HDM through the receipt repository; a dismissal must never reach it. The
    // hireLoss module does not import it at all, and no exit row is created either.
    expect(custodyExitRepo.createExitTx).not.toHaveBeenCalled();
    expect(txStub.hireCustodyExit.create).not.toHaveBeenCalled();
  });

  it("does NOT touch physical custody — the tester is still broken", async () => {
    await dismiss();
    // Custody is the other column, and nothing here may move it. `returned_to_supplier` and
    // `withdrawn` are custody facts about where equipment is; "nobody is paying" is not one.
    expect(custodyExitRepo.moveCustodyStateTx).not.toHaveBeenCalled();
    // Nor the engineer's holding, nor the hire's issued bucket.
    expect(rentalCustodyRepo.upsertRentalHoldingTx).not.toHaveBeenCalled();
    expect(poRepo.adjustHireIssuedQtyTx).not.toHaveBeenCalled();
  });

  it("leaves fieldDamageQty alone, so the units stay OUT of the issuable pool", async () => {
    await dismiss();
    // `recomputeCountersTx` derives `fieldDamageQty` from `custodyState` alone. Not calling it is the
    // proof that dismissal cannot restore a damaged unit to stock: the counter the issuable predicate
    // reads is never recomputed, because the rows it counts never changed.
    expect(custodyExitRepo.recomputeCountersTx).not.toHaveBeenCalled();
  });

  it("does NOT convert the damage into a loss", async () => {
    await dismiss();
    expect(custodyExitRepo.createExitTx).not.toHaveBeenCalled();
    const call = vi.mocked(custodyExitRepo.moveSettlementStateTx).mock.calls[0]!;
    expect(call[3]).toBe("dismissed");
  });

  it("leaves the hire's own quantities untouched, so HRN/return caps are unchanged", async () => {
    await dismiss();
    // `receivedQuantity`, `returnedQuantity` and `damagedQuantity` all live on the hire line and only
    // the purchase-order repository writes them. A settlement decision moves no equipment, so none of
    // them may be reached from here.
    expect(poRepo.adjustHireIssuedQtyTx).not.toHaveBeenCalled();
    expect(txStub.engineerRentalHolding.updateMany).not.toHaveBeenCalled();
  });

  it("preserves the engineer's evidence — the reason, photo, quantity and job context", async () => {
    await dismiss();
    const call = vi.mocked(custodyExitRepo.moveSettlementStateTx).mock.calls[0]!;
    // The update carries the decision date and NOTHING that could overwrite what the engineer wrote.
    expect(Object.keys(call[4] as object)).toEqual(["settledAt"]);
  });

  it("records the decision and its reason on the audit trail", async () => {
    await dismiss({ reason: "Provider agreed to absorb it" });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rental_damage.dismissed",
        targetId: PO_ID,
        metadata: expect.objectContaining({
          dismissReason: "Provider agreed to absorb it",
          quantity: 2,
          jobNumber: "JOB-2026-0117",
        }),
      }),
    );
  });

  it("is idempotent — a repeated dismissal succeeds without a second decision", async () => {
    // The compare-and-set loses (already dismissed), and the re-read agrees.
    vi.mocked(custodyExitRepo.moveSettlementStateTx).mockResolvedValue(false);
    vi.mocked(custodyExitRepo.findById)
      .mockResolvedValueOnce(damageExit() as never)
      .mockResolvedValueOnce(damageExit({ settlementState: "dismissed" }) as never);

    const res = await dismiss();

    expect(res).toEqual({ exitId: "x".repeat(24), settlementState: "dismissed", changed: false });
    // No second audit entry: nothing changed, and a repeated line would read as a second decision.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("refuses when someone charged it in the same moment", async () => {
    vi.mocked(custodyExitRepo.moveSettlementStateTx).mockResolvedValue(false);
    vi.mocked(custodyExitRepo.findById)
      .mockResolvedValueOnce(damageExit() as never)
      .mockResolvedValueOnce(damageExit({ settlementState: "settled" }) as never);
    await expect(dismiss()).rejects.toThrow(/settled by someone else/i);
  });

  it("refuses a record already settled with the provider", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(damageExit({ settlementState: "settled" }) as never);
    await expect(dismiss()).rejects.toThrow(/already been settled/i);
    expect(custodyExitRepo.moveSettlementStateTx).not.toHaveBeenCalled();
  });

  it("refuses a withdrawn or recovered record — there is no live claim to drop", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(damageExit({ custodyState: "withdrawn" }) as never);
    await expect(dismiss()).rejects.toThrow(/withdrawn/i);
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(damageExit({ custodyState: "recovered" }) as never);
    await expect(dismiss()).rejects.toThrow(/withdrawn/i);
    expect(custodyExitRepo.moveSettlementStateTx).not.toHaveBeenCalled();
  });

  it("accepts a report on kit the provider has already collected", async () => {
    // A wrong claim is usually found when they dispute the invoice, weeks after collection — the same
    // case `chargeCustodyExit` and the note withdrawal both accept. Custody stays `returned_to_supplier`.
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(damageExit({ custodyState: "returned_to_supplier" }) as never);
    await expect(dismiss()).resolves.toMatchObject({ changed: true });
    expect(custodyExitRepo.moveCustodyStateTx).not.toHaveBeenCalled();
  });

  it("refuses a LOSS record — a different commercial question", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(damageExit({ kind: "loss", custodyState: "lost" }) as never);
    await expect(dismiss()).rejects.toThrow(/only a damage report/i);
    expect(custodyExitRepo.moveSettlementStateTx).not.toHaveBeenCalled();
  });

  it("enforces warehouse scoping on the exit's own warehouse", async () => {
    await dismiss();
    expect(vi.mocked(assertWarehouseAccess)).toHaveBeenCalledWith(expect.objectContaining({ email: "pm@x.co" }), WH_ID);
  });

  it("rejects a caller outside the record's warehouse before writing anything", async () => {
    vi.mocked(assertWarehouseAccess).mockImplementationOnce(() => {
      throw new Error("You don't have access to that warehouse.");
    });
    await expect(dismiss()).rejects.toThrow(/access to that warehouse/i);
    expect(custodyExitRepo.moveSettlementStateTx).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it("requires a stated reason — a blank one is not a decision", async () => {
    await expect(dismiss({ reason: "   " })).rejects.toThrow(/say why/i);
    expect(custodyExitRepo.moveSettlementStateTx).not.toHaveBeenCalled();
  });

  it("404s a record that no longer exists", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(null as never);
    await expect(dismiss()).rejects.toThrow(/no longer exists/i);
  });
});
