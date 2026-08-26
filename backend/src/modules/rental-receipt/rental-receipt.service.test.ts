import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./rental-receipt.repository.js", () => ({
  findById: vi.fn(),
  findByCode: vi.fn(),
  findByPurchaseOrder: vi.fn(),
  createWithCode: vi.fn(),
  reverseReceipt: vi.fn(),
  updateDamageCharges: vi.fn(),
  receivedTotalsByLine: vi.fn(),
  damagedTotalsByLine: vi.fn(),
  hireLinesForOrderTx: vi.fn(),
  addAttachment: vi.fn(),
  findAttachment: vi.fn(),
  deleteAttachment: vi.fn(),
}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({
  findById: vi.fn(),
  findByCode: vi.fn(),
  // The real list, not a stand-in: the service builds its receiving window from it, and a mock that
  // invented its own would let these tests pass while the two flows drifted apart in production.
  RECEIVABLE_PO_STATUSES: ["sent", "supplier_accepted", "partially_received"],
}));
vi.mock("#modules/purchase-order/purchase-order.service.js", () => ({
  recomputeRentalReceiptStatus: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/warehouse-access.js", () => ({ assertWarehouseAccess: vi.fn() }));
vi.mock("#modules/attachment/attachment.service.js", () => ({ releaseAsset: vi.fn() }));
// Realtime is fire-and-forget and must never affect the caller — mocked so a test can assert every
// movement fans a refetch signal out to the rental watchers. A stale receiving row is how the same
// delivery gets booked in twice.
vi.mock("../../lib/realtime.js", () => ({
  emitAttentionChanged: vi.fn(),
  emitToRoom: vi.fn(),
  emitToUser: vi.fn(),
  RENTAL_WATCHERS_ROOM: "rentals:watchers",
}));

import * as receiptRepo from "./rental-receipt.repository.js";
// The custody records a note settles. Stubbed rather than exercised: what belongs to THIS suite is
// which of them a note reaches for, not how they move — that is pinned in the repository's own tests.
vi.mock("#modules/purchase-order/hireCustodyExit.repository.js", () => ({
  createExitTx: vi.fn(async () => ({ id: "x1" })),
  moveSettlementStateTx: vi.fn(async () => true),
  moveCustodyStateTx: vi.fn(async () => true),
  recomputeCountersTx: vi.fn(async () => ({ fieldDamageQty: 0, lostQuantity: 0 })),
  findById: vi.fn(),
  settleOpenDamageAgainstNoteTx: vi.fn(async () => 0),
  openDamageQtyByLines: vi.fn(async () => new Map<string, number>()),
  findByReceiptTx: vi.fn(async () => []),
  findBySourceTx: vi.fn(async () => []),
  CUSTODY_HELD_DAMAGED: "held_damaged",
  CUSTODY_RECOVERED: "recovered",
  CUSTODY_WITHDRAWN: "withdrawn",
  CUSTODY_LOST: "lost",
  SETTLE_UNSETTLED: "unsettled",
  SETTLE_SETTLED: "settled",
  SETTLE_DISMISSED: "dismissed",
}));
import * as custodyExitRepo from "#modules/purchase-order/hireCustodyExit.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import { recomputeRentalReceiptStatus } from "#modules/purchase-order/purchase-order.service.js";
import * as audit from "#modules/audit/audit.service.js";
import * as attachmentService from "#modules/attachment/attachment.service.js";
import { emitAttentionChanged, emitToRoom } from "../../lib/realtime.js";
import {
  assertCanAttach,
  createRentalReceipt,
  createRentalReturn,
  listForPurchaseOrder,
  removePhoto,
  chargeCustodyExit,
  reportHireDamage,
  recordDamageCharge,
  reverseRentalReceipt,
} from "./rental-receipt.service.js";

const PO_ID = "a".repeat(24);
const LINE_ID = "b".repeat(24);
const LINE_2 = "c".repeat(24);
// A real ObjectId shape: the service resolves a 24-hex argument by id and anything else by CODE, so a
// fixture id like "r1" would send every read down the by-code path.
const RECEIPT_ID = "d".repeat(24);
const ACTOR = { type: "user" as const, id: "u1", email: "wm@x.co", permissions: ["rentals.hire.manage"] };

const findPo = vi.mocked(poRepo.findById);
const createWithCode = vi.mocked(receiptRepo.createWithCode);
const reverseReceipt = vi.mocked(receiptRepo.reverseReceipt);
const findReceipt = vi.mocked(receiptRepo.findById);
const receivedTotals = vi.mocked(receiptRepo.receivedTotalsByLine);
// Damage is counted across BOTH the notes that can record it — a report and a collection note — so
// the reversal recompute reads its own total rather than the direction-filtered one.
const damagedTotals = vi.mocked(receiptRepo.damagedTotalsByLine);

// A stand-in transaction client. reverseReceipt now takes the RECOMPUTE rather than its result and
// runs it against the transaction that writes the answer, so a test that wants to see the updates
// runs that work itself — with a marker the deferral test can also assert was threaded through.
// The reversal now also unwinds custody exits through this same transaction, so the stub has to
// answer the two reads it makes. Empty by default: most reversals here predate custody exits and have
// none, and the tests that care about them set their own rows.
const TX = { marker: "tx", hireCustodyExit: { findMany: async () => [] } } as never;
const updatesOf = async (call = 0) => await reverseReceipt.mock.calls[call]![2](TX);

/**
 * Stand in for reverseReceipt, RUNNING the recompute the way the real repository does.
 *
 * A mock that only resolves would never invoke the builder — and since the reversal's guards
 * ("already returned", "already partly back") now throw from inside it, every one of their tests
 * would pass while asserting nothing. The transaction aborting on that throw is the production
 * behaviour being stood in for.
 */
const reverseReturning = (row: unknown) =>
  reverseReceipt.mockImplementation(async (_id, _stamp, build) => {
    await build(TX);
    return row as never;
  });

const hire = (over: Record<string, unknown> = {}) => ({
  id: LINE_ID,
  itemName: "Fibre Tester",
  baseUnit: "Each",
  quantity: 3,
  receivedQuantity: 0,
  fullyReceived: false,
  returnedQuantity: 0,
  fullyReturned: false,
  damagedQuantity: 0,
  hireStatus: "awaiting_delivery",
  ...over,
});

const po = (over: Record<string, unknown> = {}) =>
  ({
    id: PO_ID,
    code: "PO-0062",
    status: "sent",
    warehouseId: "w1",
    supplierId: "s1",
    supplierName: "kansha",
    items: [],
    rentalItems: [hire()],
    ...over,
  }) as never;

const receiptRow = (over: Record<string, unknown> = {}) =>
  ({
    id: RECEIPT_ID,
    code: "HDN-0001",
    direction: "in",
    purchaseOrderId: PO_ID,
    warehouseId: "w1",
    condition: "good",
    deliveryDate: new Date("2026-08-17T00:00:00Z"),
    createdAt: new Date("2026-08-17T00:00:00Z"),
    reversedAt: null,
    lines: [
      { id: "rl1", purchaseOrderRentalLineId: LINE_ID, itemName: "Fibre Tester", receivedQuantity: 2, damagedQuantity: 0, assetTags: [], orderedQuantity: 3, previouslyReceived: 0, notes: null, baseUnit: "Each" },
    ],
    attachments: [],
    warehouse: { id: "w1", code: "WH-0011", name: "test work" },
    ...over,
  }) as never;

const body = (over: Record<string, unknown> = {}) =>
  ({
    purchaseOrderId: PO_ID,
    deliveryDate: new Date("2026-08-17T00:00:00Z"),
    lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 2 }],
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  findPo.mockResolvedValue(po());
  createWithCode.mockResolvedValue(receiptRow());
  // The reversal re-reads the hire lines inside its transaction instead of trusting the snapshot the
  // purchase-order read returned. Wired to the SAME fixture so every existing `po({ rentalItems })`
  // still describes what the reversal sees — the change is when they are read, not what they say.
  vi.mocked(receiptRepo.hireLinesForOrderTx).mockImplementation(
    (async () => ((await findPo(PO_ID)) as unknown as { rentalItems: [] } | null)?.rentalItems ?? []) as never,
  );
  damagedTotals.mockResolvedValue(new Map());
  // Re-seeded here, not left to the module factory: `clearAllMocks` clears CALLS, not implementations,
  // so a test that seeds a pending damage report would otherwise leak it into every collection note
  // after it in the file.
  vi.mocked(custodyExitRepo.openDamageQtyByLines).mockResolvedValue(new Map());
});

// A delivery of hired kit is a RECORD, not an assertion: quantities, condition, the supplier's asset
// tags and photographs, kept per arrival. These pin the rules that record has to obey.
describe("createRentalReceipt", () => {
  it("writes the receipt line with the ordered and previously-received snapshots", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 1 })] }));
    await createRentalReceipt(body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 2 }] }), ACTOR);
    const [, lines] = createWithCode.mock.calls[0]!;
    expect(lines[0]).toMatchObject({
      itemName: "Fibre Tester",
      orderedQuantity: 3,
      previouslyReceived: 1,
      receivedQuantity: 2,
    });
  });

  // ANY quantity arriving starts the hire: the return deadline applies to the units that are here, and
  // a part delivery is still kit in our yard. How much is here is the quantity's job to say.
  it("starts the hire on the first delivery, however partial", async () => {
    await createRentalReceipt(body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 1 }] }), ACTOR);
    const [, , hireUpdates] = createWithCode.mock.calls[0]!;
    expect(hireUpdates[0]).toMatchObject({
      id: LINE_ID,
      // The optimistic guard: this write only lands if nothing moved the total since it was read.
      expect: { receivedQuantity: 0 },
      data: { receivedQuantity: 1, hireStatus: "on_hire", fullyReceived: false },
    });
  });

  // The queue is quantity-based, so this flag is what takes a line OFF it. Written in the same
  // transaction as the number it summarises.
  it("marks the line fully received once the last unit arrives", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 1 })] }));
    await createRentalReceipt(body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 2 }] }), ACTOR);
    const [, , hireUpdates] = createWithCode.mock.calls[0]!;
    expect(hireUpdates[0]!.data).toMatchObject({ receivedQuantity: 3, fullyReceived: true });
  });

  it("does not re-start a hire that is already on hire, but still adds the quantity", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 1, hireStatus: "on_hire" })] }));
    await createRentalReceipt(body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 2 }] }), ACTOR);
    const [, , hireUpdates] = createWithCode.mock.calls[0]!;
    expect(hireUpdates[0]!.data).toMatchObject({ receivedQuantity: 3 });
    // Already on hire — the status and its stamps are left exactly as they were.
    expect(hireUpdates[0]!.data).not.toHaveProperty("hireStatus");
  });

  // The form was drawn from a snapshot and another delivery may have landed since — so the cap is
  // re-checked here, against the live order.
  it("refuses more than is still outstanding", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 2 })] }));
    await expect(
      createRentalReceipt(body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 2 }] }), ACTOR),
    ).rejects.toThrow(/only 1 still outstanding/i);
    expect(createWithCode).not.toHaveBeenCalled();
  });

  it("refuses a line that is already fully received", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 3 })] }));
    await expect(createRentalReceipt(body(), ACTOR)).rejects.toThrow(/all 3 already received/i);
  });

  it("refuses a delivery against a hire that has already gone back", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ hireStatus: "returned" })] }));
    await expect(createRentalReceipt(body(), ACTOR)).rejects.toThrow(/already been returned/i);
  });

  it("refuses a line that is not on this order", async () => {
    await expect(
      createRentalReceipt(body({ lines: [{ purchaseOrderRentalLineId: LINE_2, receivedQuantity: 1 }] }), ACTOR),
    ).rejects.toThrow(/not on this purchase order/i);
  });

  it("refuses an order with no hire lines at all", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [] }));
    await expect(createRentalReceipt(body(), ACTOR)).rejects.toThrow(/no hire lines/i);
  });

  // The RECEIVING window is goods-in's, exactly — the client's rule is that a hire follows the IRM
  // flow. A draft order has not been sent, so kit arriving against it is kit arriving against an
  // order the supplier never got; `pending_approval` and `approved` are the same story mid-signoff.
  it("refuses any order that has not been issued to the supplier", async () => {
    for (const status of ["draft", "pending_approval", "approved", "pm_review", "cancelled", "closed"]) {
      findPo.mockResolvedValue(po({ status }));
      await expect(createRentalReceipt(body(), ACTOR)).rejects.toThrow(/can no longer be received/i);
    }
    expect(createWithCode).not.toHaveBeenCalled();
  });

  it("accepts the three statuses goods-in receives against", async () => {
    for (const status of ["sent", "supplier_accepted", "partially_received"]) {
      createWithCode.mockClear();
      findPo.mockResolvedValue(po({ status }));
      await createRentalReceipt(body(), ACTOR);
      expect(createWithCode, status).toHaveBeenCalled();
    }
  });

  // A van bringing two of four lines posts zeroes for the other two, because the form posts exactly
  // what it displayed. Those must not become receipt lines — a delivery records what arrived on it.
  it("drops zero-quantity lines rather than recording them", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire(), hire({ id: LINE_2, itemName: "Splicer" })] }));
    await createRentalReceipt(
      body({
        lines: [
          { purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 2 },
          { purchaseOrderRentalLineId: LINE_2, receivedQuantity: 0 },
        ],
      }),
      ACTOR,
    );
    const [, lines] = createWithCode.mock.calls[0]!;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.purchaseOrderRentalLineId).toBe(LINE_ID);
  });

  it("refuses a delivery where nothing at all arrived", async () => {
    await expect(
      createRentalReceipt(body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 0 }] }), ACTOR),
    ).rejects.toThrow(/at least one line/i);
  });

  it("refuses more damaged than arrived", async () => {
    await expect(
      createRentalReceipt(
        body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 1, damagedQuantity: 2 }] }),
        ACTOR,
      ),
    ).rejects.toThrow(/damaged can't be more/i);
  });

  // Empty boxes on the form must not become empty strings in the record — an asset tag is either a
  // real identifier or absent.
  it("drops blank asset tags", async () => {
    await createRentalReceipt(
      body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 2, assetTags: ["A001", "  ", ""] }] }),
      ACTOR,
    );
    const [, lines] = createWithCode.mock.calls[0]!;
    expect(lines[0]!.assetTags).toEqual(["A001"]);
  });

  // REGRESSION. `fullyReturned` says "everything we currently hold has gone back", which is a claim
  // ABOUT `receivedQuantity` — so raising the one has to re-derive the other.
  //
  // Receive 2 → return those 2 (`fullyReturned: true`, correct) → receive the outstanding 3. A stale
  // `true` left the line matching NO predicate at all: not `onHireWhere` (asks `fullyReturned:
  // false`), not `awaitingDeliveryWhere` (asks `fullyReceived: false`). Three units of the supplier's
  // kit in the yard, on no list, no badge, no export and no deadline reminder.
  it("re-derives fullyReturned when a later delivery raises what we hold", async () => {
    findPo.mockResolvedValue(
      po({ rentalItems: [hire({ receivedQuantity: 2, returnedQuantity: 2, fullyReturned: true, hireStatus: "on_hire" })] }),
    );
    await createRentalReceipt(body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 1 }] }), ACTOR);
    const [, , hireUpdates] = createWithCode.mock.calls[0]!;
    expect(hireUpdates[0]!.data).toMatchObject({ receivedQuantity: 3, fullyReturned: false });
  });

  it("leaves fullyReturned true when the delivery does not outrun what has gone back", async () => {
    findPo.mockResolvedValue(
      po({ rentalItems: [hire({ quantity: 5, receivedQuantity: 2, returnedQuantity: 3, fullyReturned: true, hireStatus: "on_hire" })] }),
    );
    await createRentalReceipt(body({ lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 1 }] }), ACTOR);
    const [, , hireUpdates] = createWithCode.mock.calls[0]!;
    expect(hireUpdates[0]!.data).toMatchObject({ receivedQuantity: 3, fullyReturned: true });
  });

  // A hire-only order used to sit in `sent` forever, because the only path to `fully_received` counted
  // IRM lines and there were none.
  it("re-derives the order's received status", async () => {
    await createRentalReceipt(body(), ACTOR);
    expect(vi.mocked(recomputeRentalReceiptStatus)).toHaveBeenCalledWith(PO_ID, ACTOR);
  });

  // The purchase order's own Audit Trail tab renders `changes[]` labels and nothing else.
  it("records an audit entry the order's own trail can render", async () => {
    await createRentalReceipt(body(), ACTOR);
    const entry = vi.mocked(audit.record).mock.calls[0]![0]!;
    expect(entry.action).toBe("rental_receipt.created");
    const changes = (entry.metadata as { changes: { label: string }[] }).changes;
    expect(changes[0]!.label).toContain("Fibre Tester");
    expect(changes[0]!.label).toContain("HDN-0001");
  });
});

describe("reverseRentalReceipt", () => {
  /**
   * Reversing an ARRIVAL asks the totals TWO questions: how much of the IN direction still stands,
   * and whether ANY of it has since gone back. One mocked value cannot answer both — a flat map would
   * have every test claiming a return exists and tripping the guard below.
   */
  const totalsBy = (live: number, returned = 0) =>
    receivedTotals.mockImplementation(async (_po: string, direction = "in") =>
      direction === "out" ? new Map(returned ? [[LINE_ID, returned]] : []) : new Map([[LINE_ID, live]]),
    );

  beforeEach(() => {
    findReceipt.mockResolvedValue(receiptRow());
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 2, hireStatus: "on_hire" })] }));
    totalsBy(2);
    reverseReturning(receiptRow({ reversedAt: new Date() }));
  });

  /**
   * The recompute has to happen INSIDE the transaction that writes its result.
   *
   * `buildReversalUpdates` produces ABSOLUTE running totals — "this line now has 3" — derived from
   * the notes that still stand. Computed before the transaction opens, those numbers can be stale
   * before they land: a warehouse user commits a new delivery note for 1 unit in the window, guarded
   * correctly by its own optimistic `expect`, and the reversal then writes its pre-read 5 − 2 = 3
   * straight over it. The new note's unit is erased from the total with nothing left to re-trigger
   * the calculation, and because the two writes never overlap in time Mongo raises no write conflict
   * to catch it. `fullyReceived` and the receiving queue follow the wrong number from then on.
   *
   * The repository's own note says the recompute "is already derived from the surviving notes inside
   * the same transaction" — this is the test that makes that true rather than merely intended.
   */
  it("defers the recompute into the transaction that writes it", async () => {
    receivedTotals.mockClear();
    await reverseRentalReceipt(RECEIPT_ID, { reason: "wrong order" }, ACTOR);

    // The third argument is the WORK, not its result — the repository runs it against the client of
    // the transaction that writes the answer.
    expect(typeof reverseReceipt.mock.calls[0]![2]).toBe("function");

    // And every read it makes goes through that client rather than the ambient one. This is the
    // whole guarantee: read on `prisma`, these totals are a snapshot from before the transaction
    // opened, and the absolute figure derived from them can be stale by the time it lands.
    expect(receivedTotals).toHaveBeenCalled();
    for (const call of receivedTotals.mock.calls) expect(call.at(-1)).toBe(TX);
    expect(vi.mocked(receiptRepo.hireLinesForOrderTx)).toHaveBeenCalledWith(TX, PO_ID);
  });

  // Recomputed from the receipts that remain, never decremented — the total is always the sum of what
  // is still on file.
  it("gives the quantity back and returns a hire that never arrived to awaiting delivery", async () => {
    await reverseRentalReceipt(RECEIPT_ID, { reason: "recorded against the wrong order" }, ACTOR);
    const updates = await updatesOf();
    expect(updates[0]).toEqual({
      id: LINE_ID,
      data: { receivedQuantity: 0, fullyReceived: false, hireStatus: "awaiting_delivery", receivedAt: null, receivedBy: null },
    });
  });

  it("leaves the hire on hire when earlier deliveries still stand", async () => {
    totalsBy(3); // 3 live, this receipt carried 2
    await reverseRentalReceipt(RECEIPT_ID, { reason: "duplicate entry" }, ACTOR);
    const updates = await updatesOf();
    expect(updates[0]).toEqual({ id: LINE_ID, data: { receivedQuantity: 1, fullyReceived: false } });
  });

  // A TERMINAL order takes no more movements, and a reversal is the one that puts quantity BACK.
  //
  // Reversing a return on a closed order left the hire `on_hire` while the order stayed closed: the
  // deadline badges chased it again, `Return hire` refused it (a closed order is outside the holding
  // window), and the only way out was the no-evidence quick close — on a hire whose record was being
  // corrected precisely because it needed evidence.
  it.each(["closed", "cancelled"])("refuses to reverse anything on a %s order", async (status) => {
    findPo.mockResolvedValue(po({ status, rentalItems: [hire({ receivedQuantity: 2, hireStatus: "on_hire" })] }));
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "collection never happened" }, ACTOR)).rejects.toThrow(
      new RegExp(`${status} — its hire records can no longer be reversed`, "i"),
    );
    expect(reverseReceipt).not.toHaveBeenCalled();
  });

  it("refuses to reverse twice", async () => {
    findReceipt.mockResolvedValue(receiptRow({ reversedAt: new Date() }));
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "again" }, ACTOR)).rejects.toThrow(/already been reversed/i);
    expect(reverseReceipt).not.toHaveBeenCalled();
  });

  // Reversing the delivery is the one movement that can UNDO half a short close. The recompute owns
  // `receivedQuantity`, `fullyReceived` and the status; it knows nothing about `cancelledQuantity`,
  // so it would put the line back on the intake queue while the shortfall it cannot reach stays
  // recorded beside it — `received + cancelled = ordered`, the invariant that column exists for,
  // quietly broken. And the line could never take a delivery again, because `shortClosedAt` refuses
  // one. Refused whole, for the same reason a delivery is: reopening a short close is a decision to
  // make deliberately, not a side effect of correcting a note.
  it("refuses to reverse a delivery against a hire that was closed short", async () => {
    findPo.mockResolvedValue(
      po({
        rentalItems: [
          hire({ quantity: 5, receivedQuantity: 2, fullyReceived: true, hireStatus: "on_hire", shortClosedAt: new Date("2026-09-05") }),
        ],
      }),
    );
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "recorded twice" }, ACTOR)).rejects.toThrow(
      /closed short/i,
    );
  });

  // A PARTIAL return leaves the line `on_hire`, so a status-only guard let this through: reverse the
  // delivery afterwards and the line has returned more than it ever received. `held` goes negative,
  // every screen clamps it to zero, and the warehouse pane — which lists `held > 0` — drops the one
  // row that proves the arithmetic broke.
  it("refuses once ANY of the delivery has gone back, even on a line still on hire", async () => {
    totalsBy(2, 1); // one unit already returned, hire still on_hire
    // The refusal now NAMES the claim and counts it, rather than stating a category. Same guard, and
    // the assertion is on both halves: the shortfall ("1 of the 2") and what is holding it.
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "mistake" }, ACTOR)).rejects.toThrow(
      /only 1 of the 2 units .* still untouched here — 1 already back with the supplier/i,
    );
    // The refusal is raised from inside the recompute, which now runs within the transaction — so
    // the transaction opens and then aborts, and nothing is stamped or written. Evaluating the guard
    // in there is the point: read outside, it could be satisfied by a snapshot that a concurrent
    // return had already invalidated.
    await expect(updatesOf()).rejects.toThrow(/still untouched here/i);
  });

  /**
   * A LOSS SETTLEMENT IS A CHARGE, AND A CHARGE MOVES NO EQUIPMENT.
   *
   * `loss` used to fall past the `damage` and `out` branches into the ARRIVAL path, which reads the
   * totals of the notes in its own direction and writes them to the hire's `receivedQuantity`. On a
   * fully-received hire that meant reversing one HLS note set `received` to 0 — a live, delivered
   * order back on the intake queue, with no error raised and nothing on screen to explain it.
   *
   * The assertion is that it writes NOTHING, not that it writes something better: any hire update at
   * all from a credit note is the bug, whatever value it carries.
   */
  it("writes no quantity at all when a loss settlement is reversed", async () => {
    findReceipt.mockResolvedValue(receiptRow({ code: "HLS-0001", direction: "loss" }));
    await reverseRentalReceipt(RECEIPT_ID, { reason: "credited" }, ACTOR);
    await expect(updatesOf()).resolves.toEqual([]);
  });

  // ── THE THREE CLAIMS A STATUS-SHAPED GUARD COULD NOT SEE ──────────────────────────────────────
  //
  // Each of these left the delivery reversible while the units it delivered were demonstrably not on
  // the shelf. The damage is the same every time and it is silent: `received` drops below what the
  // surviving records account for, and every screen clamps the negative away with `Math.max(0, …)`.
  //
  // Driven through the HIRE LINE rather than the note totals, because that is where each fact lives.
  const reversingWith = (over: Record<string, unknown>) =>
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 2, hireStatus: "on_hire", ...over })] }));

  it("refuses while any of the delivery is out with an engineer", async () => {
    reversingWith({ issuedQuantity: 1 });
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "mistake" }, ACTOR)).rejects.toThrow(
      /1 out with an engineer/i,
    );
    await expect(updatesOf()).rejects.toThrow(/out with an engineer/i);
  });

  it("refuses once a unit has been declared lost", async () => {
    reversingWith({ lostQuantity: 1 });
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "mistake" }, ACTOR)).rejects.toThrow(
      /1 declared lost/i,
    );
  });

  it("refuses while a unit is reported damaged in our custody", async () => {
    reversingWith({ fieldDamageQty: 1 });
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "mistake" }, ACTOR)).rejects.toThrow(
      /1 reported damaged here/i,
    );
  });

  // Several at once read as one list, not as whichever the code happened to test first — the bay needs
  // to know everything in the way, or they clear one and meet the next refusal.
  it("names every claim in the way, not just the first", async () => {
    reversingWith({ receivedQuantity: 4, issuedQuantity: 1, lostQuantity: 1, fieldDamageQty: 1 });
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "mistake" }, ACTOR)).rejects.toThrow(
      /1 out with an engineer, 1 declared lost, 1 reported damaged here/i,
    );
  });

  // THE CASE THIS RULE EXISTS TO ALLOW. A hire with two deliveries and some kit out on a job can still
  // unwind the note whose units never moved — a blanket "anything issued blocks everything" would take
  // the only correction path away from the larger, busier orders that need it most.
  it("allows a delivery whose own units are all still on the shelf", async () => {
    reversingWith({ receivedQuantity: 5, issuedQuantity: 3 });
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "mistake" }, ACTOR)).resolves.toBeTruthy();
  });

  // The kit was demonstrably here — it went back. Unwinding its arrival would make `returned` a lie.
  it("refuses once the hire has been returned", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 2, hireStatus: "returned" })] }));
    await expect(reverseRentalReceipt(RECEIPT_ID, { reason: "mistake" }, ACTOR)).rejects.toThrow(/already been returned/i);
    // Raised from inside the transaction, which aborts it — see the note on the test above.
    await expect(updatesOf()).rejects.toThrow(/already been returned/i);
  });

  it("re-derives the order's received status and audits the reversal", async () => {
    await reverseRentalReceipt(RECEIPT_ID, { reason: "wrong quantity" }, ACTOR);
    // `allowDowngrade`, because a reversal is the one operation that takes received quantity away.
    expect(vi.mocked(recomputeRentalReceiptStatus)).toHaveBeenCalledWith(PO_ID, ACTOR, { allowDowngrade: true });
    const entry = vi.mocked(audit.record).mock.calls[0]![0]!;
    expect(entry.action).toBe("rental_receipt.reversed");
    expect((entry.metadata as { reason: string }).reason).toBe("wrong quantity");
  });
});


// A hire is a LOOP, and the argument at the end of it is a comparison: it arrived scratched, did it go
// back worse? These pin the second half of that loop — the half that decides who pays.
describe("createRentalReturn", () => {
  const onHire = (over: Record<string, unknown> = {}) =>
    hire({ receivedQuantity: 3, fullyReceived: true, hireStatus: "on_hire", ...over });

  const returnBody = (over: Record<string, unknown> = {}) =>
    ({
      purchaseOrderId: PO_ID,
      returnDate: new Date("2026-09-01T00:00:00Z"),
      lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 3 }],
      ...over,
    }) as never;

  beforeEach(() => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire()] }));
    createWithCode.mockResolvedValue(receiptRow({ code: "HRN-0001", direction: "out" }));
  });

  // Wider than the receiving window, and it has to be: a fully-received order is the ordinary state
  // for a hire that is out, so sharing the receiving window would make the last delivery the moment
  // the kit could no longer be handed back.
  it("accepts a fully received order, which receiving does not", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [onHire()] }));
    await createRentalReturn(returnBody(), ACTOR);
    expect(createWithCode).toHaveBeenCalled();
  });

  it("refuses an order that was never issued", async () => {
    findPo.mockResolvedValue(po({ status: "draft", rentalItems: [onHire()] }));
    await expect(createRentalReturn(returnBody(), ACTOR)).rejects.toThrow(/can no longer be returned/i);
  });

  // Units in an engineer's van are not on the shelf for the provider to collect. Without this guard
  // the hire goes terminal — off the deadline badge that was the only thing chasing it — while the
  // kit is physically on a job, and it then goes missing quietly.
  it("refuses to hand back units that are out with an engineer", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ issuedQuantity: 2 })] }));
    await expect(createRentalReturn(returnBody(), ACTOR)).rejects.toThrow(/out with an engineer on a job/i);
  });

  it("still allows handing back the portion sitting at the warehouse", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ issuedQuantity: 2 })] }));
    await createRentalReturn(returnBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 1 }] }), ACTOR);
    expect(createWithCode).toHaveBeenCalled();
  });

  it("is unaffected when nothing is out with an engineer", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ issuedQuantity: 0 })] }));
    await createRentalReturn(returnBody(), ACTOR);
    expect(createWithCode).toHaveBeenCalled();
  });

  it("writes an OUT note, not a delivery", async () => {
    await createRentalReturn(returnBody(), ACTOR);
    const [header] = createWithCode.mock.calls[0]!;
    expect(header.direction).toBe("out");
    // One column for all three notes — the collection date lands on it.
    expect(header.deliveryDate).toEqual(new Date("2026-09-01T00:00:00Z"));
  });

  // The whole point of the record: who took it, on whose paperwork, in what state.
  it("keeps the collector and their note reference", async () => {
    await createRentalReturn(
      returnBody({ collectedBy: "Speedy Hire van", returnNoteRef: "SH-8891", condition: "damaged", conditionNotes: "Case cracked." }),
      ACTOR,
    );
    const [header] = createWithCode.mock.calls[0]!;
    expect(header).toMatchObject({ carrier: "Speedy Hire van", deliveryNoteRef: "SH-8891", condition: "damaged" });
  });

  it("closes the hire once everything received has gone back", async () => {
    await createRentalReturn(returnBody(), ACTOR);
    const [, , updates] = createWithCode.mock.calls[0]!;
    expect(updates[0]).toMatchObject({
      id: LINE_ID,
      expect: { returnedQuantity: 0 },
      data: { returnedQuantity: 3, fullyReturned: true, hireStatus: "returned" },
    });
  });

  // A supplier's van takes 3 of 5 today and the rest on Friday. The hire stays live for the rest.
  it("keeps the hire live on a partial collection", async () => {
    await createRentalReturn(returnBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 1 }] }), ACTOR);
    const [, , updates] = createWithCode.mock.calls[0]!;
    expect(updates[0]!.data).toMatchObject({ returnedQuantity: 1, fullyReturned: false });
    expect(updates[0]!.data).not.toHaveProperty("hireStatus");
  });

  it("adds to what has already gone back rather than replacing it", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ returnedQuantity: 1 })] }));
    await createRentalReturn(returnBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 2 }] }), ACTOR);
    const [, lines, updates] = createWithCode.mock.calls[0]!;
    expect(lines[0]).toMatchObject({ previouslyReceived: 1, receivedQuantity: 2 });
    expect(updates[0]!.data).toMatchObject({ returnedQuantity: 3, fullyReturned: true });
  });

  // Closing the hire would drop the undelivered units out of the receiving queue — `awaitingDeliveryWhere`
  // excludes `returned` — and nobody would ever chase them again.
  it("does NOT close a hire whose units are still to be delivered", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ receivedQuantity: 2, fullyReceived: false })] }));
    await createRentalReturn(returnBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 2 }] }), ACTOR);
    const [, , updates] = createWithCode.mock.calls[0]!;
    // Everything we HOLD has gone back, so the deadlines stop — but the line stays on the queue.
    expect(updates[0]!.data).toMatchObject({ returnedQuantity: 2, fullyReturned: true });
    expect(updates[0]!.data).not.toHaveProperty("hireStatus");
  });

  it("refuses more than is still out", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ returnedQuantity: 2 })] }));
    await expect(
      createRentalReturn(returnBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 2 }] }), ACTOR),
    ).rejects.toThrow(/only 1 still out/i);
    expect(createWithCode).not.toHaveBeenCalled();
  });

  // The honest answer to "we never took delivery" is to cancel the hire, not to record a collection of
  // equipment that was never in our hands.
  it("refuses a return of kit that never arrived", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire()] }));
    await expect(createRentalReturn(returnBody(), ACTOR)).rejects.toThrow(/hasn't been received yet/i);
  });

  it("refuses a second return of a closed hire", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ hireStatus: "returned" })] }));
    await expect(createRentalReturn(returnBody(), ACTOR)).rejects.toThrow(/already been returned/i);
  });

  it("refuses more damaged than went back", async () => {
    await expect(
      createRentalReturn(
        returnBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 1, damagedQuantity: 2 }] }),
        ACTOR,
      ),
    ).rejects.toThrow(/damaged can't be more/i);
  });

  it("drops zero-quantity lines and refuses a collection that took nothing", async () => {
    await expect(
      createRentalReturn(returnBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 0 }] }), ACTOR),
    ).rejects.toThrow(/at least one line/i);
  });

  // A return does not un-receive anything: the order stayed `fully_received` the moment the kit
  // arrived, and it still did arrive.
  it("never re-derives the order's received status", async () => {
    await createRentalReturn(returnBody(), ACTOR);
    expect(vi.mocked(recomputeRentalReceiptStatus)).not.toHaveBeenCalled();
  });

  it("audits under its own action, with a label the order's trail can render", async () => {
    await createRentalReturn(returnBody(), ACTOR);
    const entry = vi.mocked(audit.record).mock.calls[0]![0]!;
    expect(entry.action).toBe("rental_return.created");
    expect((entry.metadata as { changes: { label: string }[] }).changes[0]!.label).toContain("returned 3");
  });
});

// ── Damage counted ONCE, across both notes that can record it ───────────────────────────────────
//
// A damage report and a return note can each carry `damagedQuantity` and a charge. They wrote to
// different places — the report moved the hire's own tally, the return moved nothing — while the
// charge total summed BOTH (movementDatesByHireLine takes every note that is not a delivery). So the
// same broken unit reported in week one and named again on the collection note six weeks later was
// billed twice, and the tally it was billed against said one.
describe("damage is a count of UNITS, and both notes that record it share the count", () => {
  const onHire = (over: Record<string, unknown> = {}) =>
    hire({ receivedQuantity: 3, fullyReceived: true, hireStatus: "on_hire", ...over });
  const ret = (damagedQuantity: number, returnedQuantity = 3) =>
    ({
      purchaseOrderId: PO_ID,
      returnDate: new Date("2026-09-10"),
      lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity, damagedQuantity }],
    }) as never;

  beforeEach(() => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [onHire()] }));
  });

  it("moves the hire's damaged tally, so a return is not invisible to every screen that counts it", async () => {
    await createRentalReturn(ret(1), ACTOR);
    const updates = createWithCode.mock.calls[0]![2] as { data: Record<string, unknown> }[];
    expect(updates[0]!.data).toMatchObject({ damagedQuantity: 1 });
  });

  it("adds to what is already on file rather than starting again", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [onHire({ damagedQuantity: 1 })] }));
    await createRentalReturn(ret(1), ACTOR);
    const updates = createWithCode.mock.calls[0]![2] as { data: Record<string, unknown> }[];
    expect(updates[0]!.data).toMatchObject({ damagedQuantity: 2 });
  });

  // THE BUG. All three units already reported damaged; the collection note names one of them again
  // and carries the supplier's invoice. Nothing refused it, and the charge total took both.
  it("refuses a return that re-reports units already recorded damaged", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [onHire({ damagedQuantity: 3 })] }));
    await expect(createRentalReturn(ret(1), ACTOR)).rejects.toThrow(/already reported damaged/i);
    expect(createWithCode).not.toHaveBeenCalled();
  });

  it("still allows damage discovered AT the collection, on units nobody had reported", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [onHire({ damagedQuantity: 1 })] }));
    await createRentalReturn(ret(2), ACTOR);
    const updates = createWithCode.mock.calls[0]![2] as { data: Record<string, unknown> }[];
    expect(updates[0]!.data).toMatchObject({ damagedQuantity: 3 });
  });

  // Same optimistic contract the other two columns on this write already use: the new total is
  // DERIVED from the one read a moment ago, so a damage report landing in the window must lose.
  it("pins the write to the tally the new total was computed from", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [onHire({ damagedQuantity: 1 })] }));
    await createRentalReturn(ret(1), ACTOR);
    const updates = createWithCode.mock.calls[0]![2] as { expect: Record<string, unknown> }[];
    expect(updates[0]!.expect).toMatchObject({ damagedQuantity: 1 });
  });

  /**
   * THE OTHER HALF OF THE DOUBLE-COUNT, and the one the tally alone cannot see.
   *
   * An engineer brings a tester back broken. That opens a custody exit and deliberately leaves
   * `damagedQuantity` at zero — the tally moves when the exit is SETTLED, either by a warehouse note
   * that consumes it or by `chargeCustodyExit`. So a pending claim is invisible to a cap written
   * against "units never recorded damaged": the office could name the same broken unit on the
   * collection note AND charge the exit still standing open behind it, and one fault reached the
   * supplier's damaged total twice. On a 1-unit hire that is `damagedQuantity: 2` against a single
   * received unit — a number that cannot be true, on the figure the invoice is argued from.
   */
  it("refuses damage already covered by a report waiting for its note", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [onHire({ receivedQuantity: 1 })] }));
    vi.mocked(custodyExitRepo.openDamageQtyByLines).mockResolvedValue(new Map([[LINE_ID, 1]]));
    await expect(createRentalReturn(ret(1, 1), ACTOR)).rejects.toThrow(/still waiting for a note/i);
    expect(createWithCode).not.toHaveBeenCalled();
  });

  it("still allows the units the open report does not speak for", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [onHire()] }));
    vi.mocked(custodyExitRepo.openDamageQtyByLines).mockResolvedValue(new Map([[LINE_ID, 1]]));
    await createRentalReturn(ret(2), ACTOR);
    const updates = createWithCode.mock.calls[0]![2] as { data: Record<string, unknown> }[];
    expect(updates[0]!.data).toMatchObject({ damagedQuantity: 2 });
  });

  // Both ceilings apply at once, or a hire with an open report AND units already on a note would let
  // the overlap through the arm the other one was holding.
  it("nets the open report and the tally together, not one or the other", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [onHire({ damagedQuantity: 1 })] }));
    vi.mocked(custodyExitRepo.openDamageQtyByLines).mockResolvedValue(new Map([[LINE_ID, 1]]));
    await expect(createRentalReturn(ret(2), ACTOR)).rejects.toThrow(/only 1 of the 3 going back/i);
  });

  // The cap is against units NEVER recorded damaged, not against what is held — a unit that went back
  // damaged is off the site but still on the record, and the two undamaged ones behind it can still
  // break. `held - alreadyDamaged` would refuse the second of them.
  it("still lets the units nobody has reported be reported, after a damaged one went back", async () => {
    findPo.mockResolvedValue(
      po({ rentalItems: [onHire({ returnedQuantity: 1, damagedQuantity: 1 })] }),
    );
    await reportHireDamage(
      { purchaseOrderId: PO_ID, reportedDate: new Date("2026-08-25"), conditionNotes: "Both cracked.", lines: [{ purchaseOrderRentalLineId: LINE_ID, damagedQuantity: 2 }] } as never,
      ACTOR,
    );
    const [, , updates] = createWithCode.mock.calls[0]!;
    expect(updates[0]!.data).toMatchObject({ damagedQuantity: 3 });
  });
});

// The third direction: a six-week hire breaks in the MIDDLE of a hire, and a photograph taken then is
// evidence. The same fact typed into a return note six weeks later is our word against the supplier's.
describe("reportHireDamage", () => {
  const onHire = (over: Record<string, unknown> = {}) =>
    hire({ receivedQuantity: 3, fullyReceived: true, hireStatus: "on_hire", ...over });

  const damageBody = (over: Record<string, unknown> = {}) =>
    ({
      purchaseOrderId: PO_ID,
      reportedDate: new Date("2026-08-25T00:00:00Z"),
      conditionNotes: "Dropped from the tailgate.",
      lines: [{ purchaseOrderRentalLineId: LINE_ID, damagedQuantity: 1 }],
      ...over,
    }) as never;

  beforeEach(() => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire()] }));
    createWithCode.mockResolvedValue(receiptRow({ code: "HDM-0001", direction: "damage", condition: "damaged" }));
  });

  it("writes a damage note that moves nothing", async () => {
    await reportHireDamage(damageBody(), ACTOR);
    const [header, lines, updates] = createWithCode.mock.calls[0]!;
    expect(header).toMatchObject({ direction: "damage", condition: "damaged" });
    // Equal on purpose: the units this note is about, all of them damaged. It keeps
    // `damagedQuantity <= receivedQuantity` true in every direction.
    expect(lines[0]).toMatchObject({ receivedQuantity: 1, damagedQuantity: 1 });
    // No EQUIPMENT moves — the only thing that changes is what we know about it, which is exactly the
    // tally the warehouse's own pane counts. Nothing else on the line is touched.
    expect(updates).toEqual([{ id: LINE_ID, expect: { damagedQuantity: 0 }, data: { damagedQuantity: 1 } }]);
  });

  it("adds to what was already reported rather than replacing it", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ damagedQuantity: 2 })] }));
    await reportHireDamage(damageBody(), ACTOR);
    const [, , updates] = createWithCode.mock.calls[0]!;
    expect(updates[0]!.data).toMatchObject({ damagedQuantity: 3 });
  });

  it("caps the count at what is still with us, not at what was ordered", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ returnedQuantity: 2 })] }));
    await expect(
      reportHireDamage(damageBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, damagedQuantity: 2 }] }), ACTOR),
    ).rejects.toThrow(/only 1 of the 1 with us/i);
  });

  // A count of damaged UNITS, not of damage events. Without this a 1-unit line reported damaged today
  // and again tomorrow carries a running total of 2 — a number that cannot be true, sitting in the
  // database looking right, because every screen clamps it back to what is held before showing it.
  it("refuses a second report on units already reported damaged", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ receivedQuantity: 1, damagedQuantity: 1 })] }));
    await expect(reportHireDamage(damageBody(), ACTOR)).rejects.toThrow(/already reported damaged/i);
    expect(createWithCode).not.toHaveBeenCalled();
  });

  it("allows the units that are not already reported", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ damagedQuantity: 2 })] }));
    // 3 received, 2 already reported — one left, and one is what is asked for.
    await reportHireDamage(damageBody(), ACTOR);
    const [, , updates] = createWithCode.mock.calls[0]!;
    expect(updates[0]!.data).toMatchObject({ damagedQuantity: 3 });
    // ...and never more than the line holds.
    await expect(
      reportHireDamage(damageBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, damagedQuantity: 2 }] }), ACTOR),
    ).rejects.toThrow(/only 1 of the 3 with us/i);
  });

  it("refuses a report against kit that has not arrived", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire()] }));
    await expect(reportHireDamage(damageBody(), ACTOR)).rejects.toThrow(/hasn't been received yet/i);
  });

  // Damage found after the van has gone is the supplier's claim to raise, not ours to file against
  // ourselves.
  it("refuses a report against a hire that has gone back", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [onHire({ hireStatus: "returned" })] }));
    await expect(reportHireDamage(damageBody(), ACTOR)).rejects.toThrow(/gone back/i);
  });

  it("refuses a report with nothing damaged on it", async () => {
    await expect(
      reportHireDamage(damageBody({ lines: [{ purchaseOrderRentalLineId: LINE_ID, damagedQuantity: 0 }] }), ACTOR),
    ).rejects.toThrow(/at least one line/i);
  });

  // The form asks WHEN the damage was found, and a note raised on Tuesday for a fault found on Friday
  // is the ordinary case — the office writes these up in batches. The note itself carried that day
  // and the custody record stamped the moment it was typed, so one screen showed the same event on
  // two different dates, and the record's was the one nobody could explain.
  it("declares the record on the day the damage was found, not the day the note was typed", async () => {
    await reportHireDamage(damageBody({ reportedDate: new Date("2026-08-20T00:00:00Z") }), ACTOR);
    const alsoInTx = createWithCode.mock.calls[0]![3] as (tx: unknown, id: string) => Promise<void>;
    await alsoInTx({}, "r1");
    expect(vi.mocked(custodyExitRepo.createExitTx)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ declaredAt: new Date("2026-08-20T12:00:00.000Z") }),
    );
  });

  it("audits under its own action", async () => {
    await reportHireDamage(damageBody(), ACTOR);
    expect(vi.mocked(audit.record).mock.calls[0]![0]!.action).toBe("rental_damage.reported");
  });
});

// Reversing is direction-aware: giving back an arrival and giving back a RETURN are opposite motions.
describe("reverseRentalReceipt: returns and damage", () => {
  const returnRow = (over: Record<string, unknown> = {}) =>
    receiptRow({
      code: "HRN-0001",
      direction: "out",
      lines: [
        { id: "rl1", purchaseOrderRentalLineId: LINE_ID, itemName: "Fibre Tester", receivedQuantity: 3, damagedQuantity: 0, assetTags: [], orderedQuantity: 3, previouslyReceived: 0, notes: null, baseUnit: "Each" },
      ],
      ...over,
    });

  beforeEach(() => {
    findPo.mockResolvedValue(
      po({ rentalItems: [hire({ receivedQuantity: 3, fullyReceived: true, returnedQuantity: 3, fullyReturned: true, hireStatus: "returned" })] }),
    );
    reverseReturning(returnRow({ reversedAt: new Date() }));
  });

  // The kit is demonstrably still ours to give back — and the stamps go with it, because a
  // returned-on date left behind on a live hire is the leftover nobody questions.
  it("reopens a closed hire and clears its return stamps", async () => {
    findReceipt.mockResolvedValue(returnRow());
    receivedTotals.mockResolvedValue(new Map([[LINE_ID, 3]]));
    await reverseRentalReceipt(RECEIPT_ID, { reason: "collected the wrong order" }, ACTOR);
    const updates = await updatesOf();
    expect(updates[0]).toEqual({
      id: LINE_ID,
      // `damagedQuantity` rides along because a collection note can record damage — reversing one
      // gives that back with the rest of what it claimed.
      data: { returnedQuantity: 0, fullyReturned: false, damagedQuantity: 0, hireStatus: "on_hire", returnedAt: null, returnedBy: null },
    });
  });

  // Recomputed from the notes that remain, never decremented.
  it("leaves an earlier partial return standing", async () => {
    findReceipt.mockResolvedValue(
      returnRow({
        lines: [
          { id: "rl1", purchaseOrderRentalLineId: LINE_ID, itemName: "Fibre Tester", receivedQuantity: 2, damagedQuantity: 0, assetTags: [], orderedQuantity: 3, previouslyReceived: 1, notes: null, baseUnit: "Each" },
        ],
      }),
    );
    receivedTotals.mockResolvedValue(new Map([[LINE_ID, 3]])); // 3 live, this note carried 2
    await reverseRentalReceipt(RECEIPT_ID, { reason: "double entry" }, ACTOR);
    const updates = await updatesOf();
    expect(updates[0]).toEqual({
      id: LINE_ID,
      data: { returnedQuantity: 1, fullyReturned: false, damagedQuantity: 0, hireStatus: "on_hire", returnedAt: null, returnedBy: null },
    });
  });

  // A return is not a receipt: the order's received status has nothing to do with it.
  it("does not re-derive the order's received status", async () => {
    findReceipt.mockResolvedValue(returnRow());
    receivedTotals.mockResolvedValue(new Map([[LINE_ID, 3]]));
    await reverseRentalReceipt(RECEIPT_ID, { reason: "wrong order" }, ACTOR);
    expect(vi.mocked(recomputeRentalReceiptStatus)).not.toHaveBeenCalled();
    expect(vi.mocked(audit.record).mock.calls[0]![0]!.action).toBe("rental_return.reversed");
  });

  // A damage report moved no EQUIPMENT — but it did move the damaged tally, and a withdrawn claim the
  // warehouse's pane keeps counting is the same drift as any other.
  it("gives the damaged tally back when a report is withdrawn, and moves nothing else", async () => {
    findReceipt.mockResolvedValue(
      returnRow({
        code: "HDM-0001",
        direction: "damage",
        lines: [
          { id: "rl1", purchaseOrderRentalLineId: LINE_ID, itemName: "Fibre Tester", receivedQuantity: 1, damagedQuantity: 1, assetTags: [], orderedQuantity: 3, previouslyReceived: 3, notes: null, baseUnit: "Each" },
        ],
      }),
    );
    reverseReturning(returnRow({ direction: "damage", reversedAt: new Date() }));
    // 2 damaged still on file across every live note; this one carried 1.
    damagedTotals.mockResolvedValue(new Map([[LINE_ID, 2]]));
    await reverseRentalReceipt(RECEIPT_ID, { reason: "reported twice" }, ACTOR);
    const updates = await updatesOf();
    // Recomputed from the reports that remain — never decremented — and NOTHING about where the
    // equipment is is touched.
    expect(updates).toEqual([{ id: LINE_ID, data: { damagedQuantity: 1 } }]);
    // Through the transaction, so the total and the write it feeds are one commit.
    expect(damagedTotals).toHaveBeenCalledWith(PO_ID, TX);
    expect(receivedTotals).not.toHaveBeenCalledWith(PO_ID, "damage", "damagedQuantity", TX);
    expect(vi.mocked(audit.record).mock.calls[0]![0]!.action).toBe("rental_damage.reversed");
  });

  // The recompute reads BOTH kinds of note. Filtered to damage reports it would rebuild the tally
  // from half its sources and silently erase whatever a live collection note had recorded — the
  // withdrawal of one claim wiping another that still stands.
  it("keeps damage recorded on a live collection note when a report is withdrawn", async () => {
    findReceipt.mockResolvedValue(
      returnRow({
        code: "HDM-0001",
        direction: "damage",
        lines: [
          { id: "rl1", purchaseOrderRentalLineId: LINE_ID, itemName: "Fibre Tester", receivedQuantity: 1, damagedQuantity: 1, assetTags: [], orderedQuantity: 3, previouslyReceived: 3, notes: null, baseUnit: "Each" },
        ],
      }),
    );
    reverseReturning(returnRow({ direction: "damage", reversedAt: new Date() }));
    // 3 damaged across every live note — 1 on this report, 2 on a collection note that still stands.
    damagedTotals.mockResolvedValue(new Map([[LINE_ID, 3]]));
    await reverseRentalReceipt(RECEIPT_ID, { reason: "reported twice" }, ACTOR);
    const updates = await updatesOf();
    expect(updates).toEqual([{ id: LINE_ID, data: { damagedQuantity: 2 } }]);
  });

  // A collection note now MOVES the damaged tally, so reversing one has to give it back. Left out,
  // the withdrawn note's damage stays counted forever and blocks the units behind it from ever being
  // reported — the cap is against units never recorded damaged.
  it("gives back the damage a reversed collection note recorded", async () => {
    findReceipt.mockResolvedValue(
      returnRow({
        lines: [
          { id: "rl1", purchaseOrderRentalLineId: LINE_ID, itemName: "Fibre Tester", receivedQuantity: 3, damagedQuantity: 1, assetTags: [], orderedQuantity: 3, previouslyReceived: 0, notes: null, baseUnit: "Each" },
        ],
      }),
    );
    receivedTotals.mockResolvedValue(new Map([[LINE_ID, 3]]));
    damagedTotals.mockResolvedValue(new Map([[LINE_ID, 1]]));
    await reverseRentalReceipt(RECEIPT_ID, { reason: "collected the wrong order" }, ACTOR);
    const updates = await updatesOf();
    expect(updates[0]!.data).toMatchObject({ damagedQuantity: 0 });
  });
});

// A hire is worked by people in different buildings. A list left open on one desk is how the same
// delivery gets booked in twice.
describe("realtime", () => {
  it("fans every movement out to the rental watchers and the attention badges", async () => {
    await createRentalReceipt(body(), ACTOR);
    expect(vi.mocked(emitToRoom)).toHaveBeenCalledWith("rentals:watchers", "rental_hire:updated", {
      purchaseOrderId: PO_ID,
      code: "PO-0062",
    });
    expect(vi.mocked(emitAttentionChanged)).toHaveBeenCalledWith("rentals");
  });

  it("fans a return out too", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 3, fullyReceived: true, hireStatus: "on_hire" })] }));
    await createRentalReturn(
      {
        purchaseOrderId: PO_ID,
        returnDate: new Date("2026-09-01T00:00:00Z"),
        lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 3 }],
      } as never,
      ACTOR,
    );
    expect(vi.mocked(emitToRoom)).toHaveBeenCalledWith("rentals:watchers", "rental_hire:updated", expect.anything());
  });
});

// Condition photos — the evidence a damage claim at RETURN is argued with, and the one thing on a
// delivery that cannot be added later: nobody can photograph an arrival after the van has gone.
describe("condition photos", () => {
  const photo = (over: Record<string, unknown> = {}) => ({ id: "a1", fileSizeBytes: 1_000_000, ...over });

  beforeEach(() => {
    findReceipt.mockResolvedValue(receiptRow());
  });

  it("accepts a photo on a live delivery", async () => {
    await expect(assertCanAttach(RECEIPT_ID, 1_000_000, ACTOR)).resolves.toBeUndefined();
  });

  // A reversed note is the record of something that did not happen. Filing a photograph against it
  // would be evidence of an arrival the same record says never counted.
  it("refuses evidence on a reversed note", async () => {
    findReceipt.mockResolvedValue(receiptRow({ reversedAt: new Date() }));
    await expect(assertCanAttach(RECEIPT_ID, 1_000, ACTOR)).rejects.toThrow(/reversed/i);
  });

  it("caps the number of photos", async () => {
    findReceipt.mockResolvedValue(receiptRow({ attachments: Array.from({ length: 12 }, () => photo()) }));
    await expect(assertCanAttach(RECEIPT_ID, 1_000, ACTOR)).rejects.toThrow(/at most 12 photos/i);
  });

  it("caps the total size, counting what is already there", async () => {
    findReceipt.mockResolvedValue(receiptRow({ attachments: [photo({ fileSizeBytes: 39 * 1024 * 1024 })] }));
    await expect(assertCanAttach(RECEIPT_ID, 2 * 1024 * 1024, ACTOR)).rejects.toThrow(/40 MB/i);
  });

  it("404s for a delivery that does not exist", async () => {
    findReceipt.mockResolvedValue(null as never);
    await expect(assertCanAttach(RECEIPT_ID, 1_000, ACTOR)).rejects.toThrow(/not found/i);
  });

  describe("removePhoto", () => {
    beforeEach(() => {
      findReceipt.mockResolvedValue(receiptRow());
      vi.mocked(receiptRepo.findAttachment).mockResolvedValue({ id: "a1", rentalReceiptId: RECEIPT_ID } as never);
    });

    // Deleting the row is not enough: the stored asset has to be released too, and `releaseAsset`
    // counts references across every attachment table before it destroys anything.
    it("deletes the row and releases the stored asset", async () => {
      await removePhoto(RECEIPT_ID, "a1", ACTOR);
      expect(vi.mocked(receiptRepo.deleteAttachment)).toHaveBeenCalledWith("a1");
      expect(vi.mocked(attachmentService.releaseAsset)).toHaveBeenCalled();
    });

    // A photo id from another delivery must not delete anything here — the id alone is not authority.
    it("refuses an attachment belonging to a different delivery", async () => {
      vi.mocked(receiptRepo.findAttachment).mockResolvedValue({ id: "a1", rentalReceiptId: "other" } as never);
      await expect(removePhoto(RECEIPT_ID, "a1", ACTOR)).rejects.toThrow(/not found/i);
      expect(vi.mocked(receiptRepo.deleteAttachment)).not.toHaveBeenCalled();
    });

    it("refuses on a reversed note", async () => {
      findReceipt.mockResolvedValue(receiptRow({ reversedAt: new Date() }));
      await expect(removePhoto(RECEIPT_ID, "a1", ACTOR)).rejects.toThrow(/reversed/i);
    });
  });
});


// The write takes an ObjectId; the SCREENS carry a code (/rentals/receive/PO-0063). A reader that only
// accepted an id answered a perfectly good code with "not found", and the form that posted one got a
// flat "Invalid purchase order id." — so the read resolves either, exactly like every other one here.
describe("listForPurchaseOrder", () => {
  it("resolves a purchase-order CODE, not only an id", async () => {
    vi.mocked(poRepo.findByCode).mockResolvedValue(po());
    vi.mocked(receiptRepo.findByPurchaseOrder).mockResolvedValue([]);
    await listForPurchaseOrder("PO-0063", ACTOR);
    expect(vi.mocked(poRepo.findByCode)).toHaveBeenCalledWith("PO-0063");
    expect(findPo).not.toHaveBeenCalled();
  });

  it("still resolves an id", async () => {
    vi.mocked(receiptRepo.findByPurchaseOrder).mockResolvedValue([]);
    await listForPurchaseOrder(PO_ID, ACTOR);
    expect(findPo).toHaveBeenCalledWith(PO_ID);
  });
});

// ── What the supplier is charging for the damage ──────────────────────────────────────────────
//
// The one value on a note that may be set AFTER it is written, and the reason is precise rather than
// convenient: every quantity here feeds a running total on the hire line, so editing one would leave
// a stored figure disagreeing with the records it summarises — which is why this module reverses
// instead of editing. A charge feeds nothing, so correcting it can make no total wrong.
//
// It has to work that way because of when money arrives: the damage is found on a Tuesday and written
// down that day; the quote comes the following week. A charge that could only be entered with the
// report would be a guess, and a guessed zero cannot be told apart from a settled one.
describe("recording a damage charge", () => {
  const updateCharges = vi.mocked(receiptRepo.updateDamageCharges);

  const note = (over: Record<string, unknown> = {}) =>
    ({
      id: RECEIPT_ID,
      code: "HDM-0007",
      direction: "damage",
      purchaseOrderId: PO_ID,
      poCode: "PO-0067",
      warehouseId: "w1",
      // toPublic reads these off the saved row — a fixture without them tests a shape production
      // never has.
      deliveryDate: new Date("2026-07-14T00:00:00.000Z"),
      createdAt: new Date("2026-07-14T09:00:00.000Z"),
      attachments: [],
      reversedAt: null,
      lines: [
        { purchaseOrderRentalLineId: LINE_ID, itemName: "Fibre Tester", damagedQuantity: 1, damageChargePence: null },
      ],
      ...over,
    }) as never;

  beforeEach(() => {
    findReceipt.mockResolvedValue(note());
    updateCharges.mockResolvedValue(note() as never);
  });

  it("stores the figure in pence, rounded", async () => {
    // 449.99 * 100 is 44998.999... in binary floating point — truncating loses a penny per line.
    await recordDamageCharge(RECEIPT_ID, { lines: [{ purchaseOrderRentalLineId: LINE_ID, damageCharge: 449.99 }] }, ACTOR);
    expect(updateCharges).toHaveBeenCalledWith(RECEIPT_ID, undefined, [
      { purchaseOrderRentalLineId: LINE_ID, damageChargePence: 44_999 },
    ]);
  });

  // NULL is a real instruction and a different one from omitting the line: a charge that turned out
  // not to be coming has to be removable, and leaving 0 would read as "they charged us nothing".
  it("clears a charge that is not coming after all", async () => {
    await recordDamageCharge(RECEIPT_ID, { lines: [{ purchaseOrderRentalLineId: LINE_ID, damageCharge: null }] }, ACTOR);
    expect(updateCharges.mock.calls[0][2]).toEqual([{ purchaseOrderRentalLineId: LINE_ID, damageChargePence: null }]);
  });

  // Damage recorded ON ARRIVAL is the supplier's own fault, evidenced on their own delivery note. A
  // charge against it would be us booking a payment for their mistake.
  it("refuses to charge us for damage that arrived with the kit", async () => {
    findReceipt.mockResolvedValue(note({ direction: "in", code: "HDN-0004" }));
    await expect(
      recordDamageCharge(RECEIPT_ID, { lines: [{ purchaseOrderRentalLineId: LINE_ID, damageCharge: 450 }] }, ACTOR),
    ).rejects.toThrow(/supplier's own and cannot be charged to us/i);
    expect(updateCharges).not.toHaveBeenCalled();
  });

  // A reversed note withdrew its claim. Money against a withdrawn claim is counted by every total
  // that reads live rows only, and matched by nothing.
  it("refuses a note whose claim was withdrawn", async () => {
    findReceipt.mockResolvedValue(note({ reversedAt: new Date() }));
    await expect(
      recordDamageCharge(RECEIPT_ID, { lines: [{ purchaseOrderRentalLineId: LINE_ID, damageCharge: 450 }] }, ACTOR),
    ).rejects.toThrow(/reversed/i);
  });

  // A charge on a line nobody said was damaged has no claim behind it, and is far more likely to be a
  // figure typed on the wrong row than a real one.
  it("refuses a charge against a line with no damage on it", async () => {
    findReceipt.mockResolvedValue(
      note({ lines: [{ purchaseOrderRentalLineId: LINE_ID, itemName: "Fibre Tester", damagedQuantity: 0, damageChargePence: null }] }),
    );
    await expect(
      recordDamageCharge(RECEIPT_ID, { lines: [{ purchaseOrderRentalLineId: LINE_ID, damageCharge: 450 }] }, ACTOR),
    ).rejects.toThrow(/no damage recorded on this note/i);
  });

  // Named rather than ignored: a silent no-op leaves somebody looking at a figure they typed and a
  // note that does not carry it, with nothing on screen saying which line was dropped.
  it("refuses an item that is not on this note", async () => {
    await expect(
      recordDamageCharge(RECEIPT_ID, { lines: [{ purchaseOrderRentalLineId: LINE_2, damageCharge: 450 }] }, ACTOR),
    ).rejects.toThrow(/no line for one of the items sent/i);
  });

  // Money that can be edited needs BOTH figures in the trail: the new one alone says what it is and
  // gives no way to see that it moved.
  it("audits the old figure beside the new one", async () => {
    findReceipt.mockResolvedValue(
      note({ lines: [{ purchaseOrderRentalLineId: LINE_ID, itemName: "Fibre Tester", damagedQuantity: 1, damageChargePence: 30_000 }] }),
    );
    await recordDamageCharge(
      RECEIPT_ID,
      { damageChargeRef: "INV-88", lines: [{ purchaseOrderRentalLineId: LINE_ID, damageCharge: 450 }] },
      ACTOR,
    );
    const entry = vi.mocked(audit.record).mock.calls.at(-1)![0];
    expect(entry.action).toBe("rental_damage.charge_recorded");
    expect(JSON.stringify(entry.metadata)).toContain("£300.00 → £450.00");
    expect(JSON.stringify(entry.metadata)).toContain("INV-88");
  });

  it("tells the rental watchers, so an open register does not sit on a stale figure", async () => {
    await recordDamageCharge(RECEIPT_ID, { damageChargeRef: "INV-88" }, ACTOR);
    expect(emitToRoom).toHaveBeenCalled();
  });
});

// The register displays CODES, and this module's contract — stated in the RECEIPT_ID fixture note
// above and honoured by getRentalReceipt and recordDamageCharge — is that a 24-hex argument resolves
// by id and anything else by code. Three paths skipped the check and handed the raw param to
// findById, which is a findUnique on an @db.ObjectId column: Prisma answers a code with P2023
// ("Malformed ObjectID"), so the error middleware logs a 5xx and returns a generic message where the
// code plainly intends a 404. A user pasting HDN-0007 out of the register is the whole scenario.
describe("id-or-code resolution on every read", () => {
  beforeEach(() => {
    vi.mocked(receiptRepo.findByCode).mockResolvedValue(receiptRow({ reversedAt: null }) as never);
    vi.mocked(receiptRepo.findById).mockResolvedValue(null as never);
  });

  it("reverses a movement addressed by its code", async () => {
    vi.mocked(poRepo.findById).mockResolvedValue(po() as never);
    receivedTotals.mockResolvedValue(new Map() as never);
    vi.mocked(receiptRepo.reverseReceipt).mockResolvedValue(receiptRow() as never);
    await reverseRentalReceipt("HDN-0001", { reason: "booked twice" }, ACTOR);
    expect(vi.mocked(receiptRepo.findByCode)).toHaveBeenCalledWith("HDN-0001");
  });

  it("checks the photo allowance on a movement addressed by its code", async () => {
    await assertCanAttach("HDN-0001", 1000, ACTOR);
    expect(vi.mocked(receiptRepo.findByCode)).toHaveBeenCalledWith("HDN-0001");
  });

  it("removes a photo from a movement addressed by its code", async () => {
    vi.mocked(receiptRepo.findAttachment).mockResolvedValue({
      id: "att1",
      rentalReceiptId: RECEIPT_ID,
      publicId: "p1",
      resourceType: "image",
    } as never);
    await removePhoto("HDN-0001", "att1", ACTOR);
    // Resolved to the ROW's id before the ownership comparison — comparing the attachment's
    // rentalReceiptId against the raw "HDN-0001" param would reject a photo that does belong to it.
    expect(vi.mocked(receiptRepo.deleteAttachment)).toHaveBeenCalledWith("att1");
  });
});

// ── A hire closed short takes no more movements ────────────────────────────────────────────────
//
// Closing short records a DECISION — with a reason — that the outstanding units are not arriving.
// Letting a later movement write over it would erase that decision silently, so each path refuses and
// says what to do instead. Reopening a short close is not modelled, exactly as it is not for a
// customer stock assignment.
describe("movements against a hire that was closed short", () => {
  it("a delivery is refused, pointing at the record that says they are not coming", async () => {
    findPo.mockResolvedValue(
      po({ rentalItems: [hire({ receivedQuantity: 1, hireStatus: "on_hire", shortClosedAt: new Date(), fullyReceived: true })] }),
    );
    await expect(
      createRentalReceipt(
        { purchaseOrderId: PO_ID, deliveryDate: new Date("2026-09-10"), lines: [{ purchaseOrderRentalLineId: LINE_ID, receivedQuantity: 1 }] } as never,
        ACTOR,
      ),
    ).rejects.toThrow(/closed short/i);
    expect(createWithCode).not.toHaveBeenCalled();
  });

  // A CANCELLED hire never received anything, so there is nothing to hand back or to have damaged.
  it("a return is refused against a cancelled hire", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [hire({ hireStatus: "cancelled" })] }));
    await expect(
      createRentalReturn(
        { purchaseOrderId: PO_ID, returnDate: new Date("2026-09-10"), lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 1 }] } as never,
        ACTOR,
      ),
    ).rejects.toThrow(/nothing was ever delivered/i);
    expect(createWithCode).not.toHaveBeenCalled();
  });

  it("a damage report is refused against a cancelled hire", async () => {
    findPo.mockResolvedValue(po({ status: "fully_received", rentalItems: [hire({ hireStatus: "cancelled" })] }));
    await expect(
      reportHireDamage(
        { purchaseOrderId: PO_ID, deliveryDate: new Date("2026-09-10"), lines: [{ purchaseOrderRentalLineId: LINE_ID, damagedQuantity: 1 }] } as never,
        ACTOR,
      ),
    ).rejects.toThrow(/nothing was ever delivered/i);
    expect(createWithCode).not.toHaveBeenCalled();
  });

  // The held units of a PART-delivered hire still go back normally — a short close stops the ones
  // that never arrived, not the ones sitting in the yard. And because it set `fullyReceived`, the
  // return path can finally CLOSE the line, which is the deadlock it was written to break.
  it("still accepts the return of units a part-delivered short-closed hire is holding, and closes it", async () => {
    findPo.mockResolvedValue(
      po({
        status: "partially_received",
        rentalItems: [hire({ quantity: 5, receivedQuantity: 2, fullyReceived: true, hireStatus: "on_hire" })],
      }),
    );
    await createRentalReturn(
      { purchaseOrderId: PO_ID, returnDate: new Date("2026-09-10"), lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 2 }] } as never,
      ACTOR,
    );
    const hireUpdates = createWithCode.mock.calls[0]![2] as { data: Record<string, unknown> }[];
    expect(hireUpdates[0]!.data).toMatchObject({ returnedQuantity: 2, fullyReturned: true, hireStatus: "returned" });
  });

  // `closes` is derived from `fullyReceived`, so that column has to be pinned alongside the total the
  // guard already carries. A short close landing in the window flips it true, and a return that then
  // commits its stale `closes: false` leaves the line at `on_hire` with everything already back —
  // refused by the return path, refused by mark-returned, and with Close short hidden on the board.
  it("pins the return to the fullyReceived its closing decision was made against", async () => {
    findPo.mockResolvedValue(
      po({
        status: "partially_received",
        rentalItems: [hire({ quantity: 5, receivedQuantity: 2, fullyReceived: false, hireStatus: "on_hire" })],
      }),
    );
    await createRentalReturn(
      { purchaseOrderId: PO_ID, returnDate: new Date("2026-09-10"), lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 2 }] } as never,
      ACTOR,
    );
    const hireUpdates = createWithCode.mock.calls[0]![2] as { expect: Record<string, unknown> }[];
    expect(hireUpdates[0]!.expect).toMatchObject({ returnedQuantity: 0, fullyReceived: false });
  });
});

// ── Lost units leave every custody figure this module caps against ─────────────────────────────
//
// A unit declared lost is not on the shelf, so it cannot go back to the provider and it cannot be
// inspected for damage. Both caps net it off; neither did before the loss path existed, and the
// failure would have been a collection note closing a hire on equipment nobody could produce.
describe("lost units and the collection/damage caps", () => {
  it("refuses to return more than is actually still here once units are lost", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 3, returnedQuantity: 0, lostQuantity: 1, hireStatus: "on_hire" })] }));
    await expect(
      createRentalReturn(
        { purchaseOrderId: PO_ID, returnDate: new Date("2026-09-20T00:00:00Z"), lines: [{ purchaseOrderRentalLineId: LINE_ID, returnedQuantity: 3 }] },
        ACTOR,
      ),
    ).rejects.toThrow(/only 2 still out/i);
  });

  it("refuses to report damage on a unit that is lost rather than broken", async () => {
    findPo.mockResolvedValue(po({ rentalItems: [hire({ receivedQuantity: 2, returnedQuantity: 0, lostQuantity: 2, hireStatus: "on_hire" })] }));
    await expect(
      reportHireDamage(
        { purchaseOrderId: PO_ID, reportedDate: new Date("2026-09-20T00:00:00Z"), conditionNotes: "Screen cracked", lines: [{ purchaseOrderRentalLineId: LINE_ID, damagedQuantity: 1 }] },
        ACTOR,
      ),
    ).rejects.toThrow(/nothing from this line is still with us/i);
  });
});

// ── Charging ONE record that already exists ────────────────────────────────────────────────────
//
// Damage found at the warehouse is reported on a form, and the note that form creates then carries a
// charge. Damage found on a JOB was already reported — by the engineer, on the day, with a photograph —
// so reopening a report form over it asked somebody to describe, date and count it again from memory.
// This is the one call that supplies the only missing half: the money.
describe("chargeCustodyExit", () => {
  const exit = (over: Record<string, unknown> = {}) => ({
    id: "x1",
    purchaseOrderRentalLineId: LINE_ID,
    purchaseOrderId: PO_ID,
    warehouseId: "w1",
    kind: "damage",
    qty: 2,
    itemName: "Fibre Tester",
    custodyState: "held_damaged",
    settlementState: "unsettled",
    reason: "Screen cracked on site",
    notes: null,
    jobNumber: "JOB-2026-0041",
    declaredAt: new Date("2026-08-24T00:00:00Z"),
    ...over,
  });

  const charge = (over: Record<string, unknown> = {}) => chargeCustodyExit("x1", { charge: 250, ...over }, ACTOR);

  beforeEach(() => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit() as never);
    findPo.mockResolvedValue(po({ rentalItems: [hire({ hireStatus: "on_hire", damagedQuantity: 0 })] }));
  });

  it("raises the provider's document FROM the record, not from a form", async () => {
    await charge();
    const [header, lines] = createWithCode.mock.calls[0]!;
    expect(header).toMatchObject({ direction: "damage" });
    // The engineer's own words and the day it was FOUND. Stamping today's date onto a fault reported
    // last week quietly rewrites what a supplier charge is argued from.
    expect(header).toMatchObject({ conditionNotes: "Screen cracked on site", deliveryDate: new Date("2026-08-24T00:00:00Z") });
    expect(lines[0]).toMatchObject({ receivedQuantity: 2, damagedQuantity: 2, damageChargePence: 25000 });
  });

  /**
   * THE INVOICE ARRIVES AFTER THE VAN LEAVES.
   *
   * A hire's damaged units go back to the provider on the collection note — that is the only way they
   * leave — and the provider then bills us for the damage, days or weeks later. So a record whose
   * custody has moved to `returned_to_supplier` is precisely the one most likely to need charging.
   *
   * The guard here is a DENYLIST (`withdrawn`, `recovered`) and must stay one. Rewritten as "only
   * `held_damaged` may be charged" it would read as tighter and would silently close the money door at
   * the exact moment the money turned up.
   */
  it("still charges a record whose equipment has already gone back", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit({ custodyState: "returned_to_supplier" }) as never);
    await expect(charge()).resolves.toBeTruthy();
  });

  it("records an unquoted charge as NOT KNOWN, never as zero", async () => {
    // A missing quote and a supplier charging nothing are different facts, and only one of them is a
    // number.
    await charge({ charge: undefined });
    expect(createWithCode.mock.calls[0]![1][0]).toMatchObject({ damageChargePence: null });
  });

  it("advances the provider-facing damaged total, guarded on what it read", async () => {
    await charge();
    expect(createWithCode.mock.calls[0]![2]).toEqual([
      { id: LINE_ID, expect: { damagedQuantity: 0 }, data: { damagedQuantity: 2 } },
    ]);
  });

  it("raises a LOSS settlement for a loss, and keeps it out of the damaged figure", async () => {
    // The figure the provider bills damage on must never carry a unit that was never damaged.
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit({ kind: "loss", custodyState: "lost", reason: "site_theft" }) as never);
    await charge();
    expect(createWithCode.mock.calls[0]![0]).toMatchObject({ direction: "loss" });
    expect(createWithCode.mock.calls[0]![1][0]).toMatchObject({ damagedQuantity: 0, receivedQuantity: 2 });
    // …and no hire-line write at all: a loss moved its quantity when it was declared.
    expect(createWithCode.mock.calls[0]![2]).toEqual([]);
  });

  it("settles the record inside the note's own transaction", async () => {
    await charge();
    const alsoInTx = createWithCode.mock.calls[0]![3] as (tx: unknown, id: string) => Promise<void>;
    await alsoInTx({}, "r1");
    expect(vi.mocked(custodyExitRepo.moveSettlementStateTx)).toHaveBeenCalledWith(
      expect.anything(), "x1", "unsettled", "settled", expect.objectContaining({ settledByReceiptId: "r1" }),
    );
  });

  it("aborts the whole note when someone settled the record first", async () => {
    // A document raised for a claim that is already answered is a second bill.
    vi.mocked(custodyExitRepo.moveSettlementStateTx).mockResolvedValue(false);
    await charge();
    const alsoInTx = createWithCode.mock.calls[0]![3] as (tx: unknown, id: string) => Promise<void>;
    await expect(alsoInTx({}, "r1")).rejects.toThrow(/settled by someone else/i);
  });

  it("refuses a record that is already settled", async () => {
    vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit({ settlementState: "settled" }) as never);
    await expect(charge()).rejects.toThrow(/already been settled/i);
  });

  it("refuses a withdrawn report and a recovered loss", async () => {
    for (const state of ["withdrawn", "recovered"]) {
      vi.mocked(custodyExitRepo.findById).mockResolvedValue(exit({ custodyState: state }) as never);
      await expect(charge()).rejects.toThrow(/withdrawn/i);
    }
  });
});
