import { beforeEach, describe, expect, it, vi } from "vitest";

// The two actions a LIVE hire supports. Everything else about a rental line is fixed at
// conversion — it was reviewed and committed to the supplier.
vi.mock("./purchase-order.repository.js", () => ({
  findById: vi.fn(),
  findByCode: vi.fn(),
  findRentalLine: vi.fn(),
  updateRentalLine: vi.fn(),
  // Extending writes the line AND the record of what moved it, in one transaction — see
  // extendRentalLine. Two calls could leave a running total with no breakdown behind it.
  extendRentalLine: vi.fn(),
  // Mocked only so a test can assert the extension path NEVER writes the order header — that is
  // where the committed totals live.
  update: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({
  emitAttentionChanged: vi.fn(),
  emitToRoom: vi.fn(),
  emitToUser: vi.fn(),
  PURCHASE_ORDER_WATCHERS_ROOM: "purchase_orders:watchers",
  RENTAL_WATCHERS_ROOM: "rentals:watchers",
}));

import * as poRepo from "./purchase-order.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import {
  closePurchaseOrder,
  extendHire,
  getPurchaseOrder,
  markHireReturned,
  recomputeRentalReceiptStatus,
  recordSupplierAcceptance,
} from "./purchase-order.service.js";

const PO_ID = "a".repeat(24);
const ACTOR = { type: "user" as const, id: "u1", email: "pm@x.co", permissions: ["rentals.hire.manage"] };

const findById = vi.mocked(poRepo.findById);
const findRentalLine = vi.mocked(poRepo.findRentalLine);
const updateRentalLine = vi.mocked(poRepo.updateRentalLine);
const extendRentalLine = vi.mocked(poRepo.extendRentalLine);
const record = vi.mocked(audit.record);

const poRow = () =>
  ({
    id: PO_ID,
    code: "PO-0001",
    warehouseId: null,
    supplier: null,
    warehouse: null,
    items: [],
    rentalItems: [],
    attachments: [],
    goodsReceipts: [],
    purchaseRequest: null,
    job: null,
    orderDate: new Date("2026-08-01"),
    createdAt: new Date("2026-08-01"),
    updatedAt: new Date("2026-08-01"),
  }) as never;

const line = (over: Record<string, unknown> = {}) =>
  ({
    id: "l1",
    purchaseOrderId: PO_ID,
    itemName: "Fibre Tester",
    hireStatus: "on_hire",
    hireStartDate: new Date("2026-09-01T00:00:00Z"),
    hireEndDate: new Date("2026-10-01T00:00:00Z"),
    notifyDaysBefore: 3,
    // Pricing basis + the running extension total: present by default because the repository's read
    // always supplies them, so a fixture without them would be testing a shape production never has.
    quantity: 1,
    ratePeriod: "total",
    ratePence: null,
    extensionChargePence: 0,
    ...over,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  findById.mockResolvedValue(poRow());
  updateRentalLine.mockResolvedValue({} as never);
  extendRentalLine.mockResolvedValue(undefined);
});

describe("markHireReturned", () => {
  it("moves a live hire to returned and stamps who and when", async () => {
    findRentalLine.mockResolvedValue(line());
    await markHireReturned(PO_ID, "l1", ACTOR);
    const patch = updateRentalLine.mock.calls[0]![1] as Record<string, unknown>;
    expect(patch).toMatchObject({ hireStatus: "returned", returnedBy: "pm@x.co" });
    expect(patch.returnedAt).toBeInstanceOf(Date);
  });

  it("refuses a hire that is already returned", async () => {
    findRentalLine.mockResolvedValue(line({ hireStatus: "returned" }));
    await expect(markHireReturned(PO_ID, "l1", ACTOR)).rejects.toThrow(/already been returned/i);
    expect(updateRentalLine).not.toHaveBeenCalled();
  });

  // An id alone would let one purchase order act on another's line.
  it("refuses a line belonging to a different purchase order", async () => {
    findRentalLine.mockResolvedValue(line({ purchaseOrderId: "b".repeat(24) }));
    await expect(markHireReturned(PO_ID, "l1", ACTOR)).rejects.toThrow(/not found on this purchase order/i);
  });

  it("records an audit entry naming the item", async () => {
    findRentalLine.mockResolvedValue(line());
    await markHireReturned(PO_ID, "l1", ACTOR);
    expect(record.mock.calls[0]![0]).toMatchObject({
      action: "purchase_order.rental_returned",
      targetLabel: "PO-0001",
      metadata: { item: "Fibre Tester" },
    });
  });
});

describe("extendHire", () => {
  it("recomputes the notify date and clears the whole notification state", async () => {
    findRentalLine.mockResolvedValue(
      line({
        deadlineNotifiedAt: new Date("2026-09-28"),
        deadlineNotifyClaimToken: "tok-1",
        deadlineNotifyClaimExpires: new Date("2026-09-28"),
        deadlineNotifyAttempts: 1,
      }),
    );

    await extendHire(PO_ID, "l1", { hireEndDate: "2026-11-01" }, ACTOR);

    expect(extendRentalLine.mock.calls[0]![1]).toMatchObject({
      hireEndDate: new Date("2026-11-01T00:00:00.000Z"),
      notifyOnDate: new Date("2026-10-29T00:00:00.000Z"),
      deadlineNotifiedAt: null,
      deadlineNotifyClaimToken: null,
      deadlineNotifyClaimExpires: null,
      deadlineNotifyAttempts: 0,
    });
  });

  // A calendar day like every other hire date, so a time-of-day cannot shift the reminder by a
  // fraction of a day.
  it("normalises the new end date to UTC midnight", async () => {
    findRentalLine.mockResolvedValue(line());
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-11-01T17:45:00Z" }, ACTOR);
    const patch = extendRentalLine.mock.calls[0]![1] as { hireEndDate: Date };
    expect(patch.hireEndDate.toISOString()).toBe("2026-11-01T00:00:00.000Z");
  });

  // Clamping applies on extension too — a reminder lead longer than the hire itself must not pull
  // the notify date before the start. (Previously expressed with an end date EARLIER than the
  // stored one, which extendHire now refuses; a 45-day lead on a 5-week hire reaches the same
  // clamp through a real extension.)
  it("clamps the recomputed notify date to the stored start date", async () => {
    findRentalLine.mockResolvedValue(line({ notifyDaysBefore: 45 }));
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-05" }, ACTOR);
    const patch = extendRentalLine.mock.calls[0]![1] as { notifyOnDate: Date };
    expect(patch.notifyOnDate.toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });

  it("takes a new reminder lead when one is sent", async () => {
    findRentalLine.mockResolvedValue(line());
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-11-01", notifyDaysBefore: 7 }, ACTOR);
    expect(extendRentalLine.mock.calls[0]![1]).toMatchObject({
      notifyDaysBefore: 7,
      notifyOnDate: new Date("2026-10-25T00:00:00.000Z"),
    });
  });

  it("refuses an end date that is not after the stored start date", async () => {
    findRentalLine.mockResolvedValue(line());
    await expect(extendHire(PO_ID, "l1", { hireEndDate: "2026-08-01" }, ACTOR)).rejects.toThrow(
      /after the start date/i,
    );
    expect(extendRentalLine).not.toHaveBeenCalled();
  });

  // An "extension" that moves the end date BACKWARDS is not an extension. The end date is what the
  // register, the reminder and the charge are all computed from, and every one of them assumes it
  // only ever moves forward: the register renders the delta as `+{addedDays}d` (a shortening shows
  // as "+-27d"), extensionChargePence clamps the difference to zero so the move is free, and the
  // reminder is re-armed for a date that may already have passed. The Extend dialog already forbids
  // it with `min={hireEndDate}` — which is a hint to the date picker, not a rule: devtools, a stale
  // tab or any direct API call walks straight past it. This is that rule where it can be enforced.
  it("refuses an end date that is not after the CURRENT end date", async () => {
    findRentalLine.mockResolvedValue(line());
    await expect(extendHire(PO_ID, "l1", { hireEndDate: "2026-09-05" }, ACTOR)).rejects.toThrow(
      /after the current end date/i,
    );
    expect(extendRentalLine).not.toHaveBeenCalled();
  });

  // The same date is not a move at all — it would bank an audit entry and a register row recording
  // nothing, and re-arm a reminder that was already correct.
  it("refuses an end date equal to the current end date", async () => {
    findRentalLine.mockResolvedValue(line());
    await expect(extendHire(PO_ID, "l1", { hireEndDate: "2026-10-01" }, ACTOR)).rejects.toThrow(
      /after the current end date/i,
    );
    expect(extendRentalLine).not.toHaveBeenCalled();
  });

  it("refuses to extend a returned hire", async () => {
    findRentalLine.mockResolvedValue(line({ hireStatus: "returned" }));
    await expect(extendHire(PO_ID, "l1", { hireEndDate: "2026-11-01" }, ACTOR)).rejects.toThrow(/returned/i);
  });

  it("records an audit entry carrying the old and new end dates", async () => {
    findRentalLine.mockResolvedValue(line());
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-11-01" }, ACTOR);
    expect(record.mock.calls[0]![0]).toMatchObject({
      action: "purchase_order.rental_extended",
      metadata: { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" },
    });
  });
});


// An extension is a later commitment against an order the supplier has already agreed to. The money
// is therefore recorded BESIDE the order, never folded into its committed totals — and every
// extension stays individually readable in the order's own Audit Trail.
describe("extendHire — what an extension costs", () => {
  const auditOf = () => vi.mocked(audit.record).mock.calls.at(-1)![0];

  it("charges the added days on a daily rate, per unit × quantity", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "day", ratePence: 5500, quantity: 3 }));
    findById.mockResolvedValue(poRow());

    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-14" }, ACTOR);

    // 13 more days × £55 = £715 per unit; × 3 units = £2,145.
    expect(extendRentalLine.mock.calls.at(-1)![1]).toMatchObject({ extensionChargePence: 214_500 });
  });

  it("ACCUMULATES across extensions rather than replacing", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "day", ratePence: 5500, quantity: 1, extensionChargePence: 50_000 }));
    findById.mockResolvedValue(poRow());
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-14" }, ACTOR);
    expect(extendRentalLine.mock.calls.at(-1)![1]).toMatchObject({ extensionChargePence: 50_000 + 71_500 });
  });

  // The order's committed money is what the supplier agreed to; an extension must not rewrite it.
  it("never touches the price, the line total or the order's totals", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "day", ratePence: 5500, quantity: 3 }));
    findById.mockResolvedValue(poRow());
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-14" }, ACTOR);
    const patch = extendRentalLine.mock.calls.at(-1)![1] as Record<string, unknown>;
    expect(patch).not.toHaveProperty("unitPricePence");
    expect(patch).not.toHaveProperty("lineTotalPence");
    expect(poRepo.update).not.toHaveBeenCalled();
  });

  it("keeps a NEGOTIATED extension charge, and records what the rate said", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "day", ratePence: 5500, quantity: 1 }));
    findById.mockResolvedValue(poRow());

    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-14", additionalChargePence: 65_000 }, ACTOR);

    expect(extendRentalLine.mock.calls.at(-1)![1]).toMatchObject({ extensionChargePence: 65_000 });
    expect(auditOf().metadata).toMatchObject({
      calculatedAdditionalChargePence: 71_500,
      agreedAdditionalChargePence: 65_000,
      priceOverridden: true,
    });
  });

  // The `total` basis carries no rate, so an extension there is a fresh negotiation — nothing is
  // invented, and a typed figure is still honoured.
  it("charges nothing automatically on the total basis", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "total", ratePence: null, quantity: 2 }));
    findById.mockResolvedValue(poRow());
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-14" }, ACTOR);
    expect(extendRentalLine.mock.calls.at(-1)![1]).toMatchObject({ extensionChargePence: 0 });
    expect(auditOf().metadata).toMatchObject({ calculatedAdditionalChargePence: null });
  });

  // Without this the entry renders as a bare "Rental Extended" on the order's own audit tab, with
  // the dates and the money reachable only through the global log's raw-JSON drawer.
  it("writes a changes[] label so the order's Audit Trail shows the detail", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "day", ratePence: 5500, quantity: 3 }));
    findById.mockResolvedValue(poRow());
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-14" }, ACTOR);
    const label = (auditOf().metadata as { changes: { label: string }[] }).changes[0]!.label;
    expect(label).toContain("2026-10-01 → 2026-10-14");
    expect(label).toContain("£2145.00");
  });

  it("says so plainly when an extension costs nothing", async () => {
    // 10 days and 12 days are both two weeks on a weekly rate.
    findRentalLine.mockResolvedValue(
      line({ ratePeriod: "week", ratePence: 30_000, quantity: 1, hireEndDate: new Date("2026-09-11T00:00:00Z") }),
    );
    findById.mockResolvedValue(poRow());
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-09-13" }, ACTOR);
    const label = (auditOf().metadata as { changes: { label: string }[] }).changes[0]!.label;
    expect(label).toContain("no additional charge");
  });
});


// ── The breakdown behind the running total ────────────────────────────────────────────────────
//
// `extensionChargePence` is a SUM: extend three times for £275, £300 and £150 and it reads £725, with
// no way back to the three. Every extension is therefore recorded as an event of its own, and the two
// writes share a transaction — a breakdown that can disagree with the number it explains is worse
// than no breakdown, because both look authoritative and only one gets checked.
describe("extendHire records each extension as its own fact", () => {
  const extensionOf = () => extendRentalLine.mock.calls.at(-1)![2] as Record<string, unknown>;

  it("writes the event in the same call as the line it moves", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "day", ratePence: 5_500, quantity: 2 }));
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-11" }, ACTOR);
    expect(extendRentalLine).toHaveBeenCalledTimes(1);
    expect(extensionOf()).toMatchObject({
      purchaseOrderRentalLineId: "l1",
      purchaseOrderId: PO_ID,
      poCode: "PO-0001",
      itemName: "Fibre Tester",
      previousEndDate: new Date("2026-10-01T00:00:00.000Z"),
      newEndDate: new Date("2026-10-11T00:00:00.000Z"),
      addedDays: 10,
      quantity: 2,
    });
  });

  // The row has to carry the LINE charge — per unit x quantity — because that is exactly what was
  // added to the running total. Storing the per-unit figure would make the breakdown add up to half.
  it("records what was added to the total, not the per-unit figure", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "day", ratePence: 5_500, quantity: 2 }));
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-11" }, ACTOR);
    const added = (extendRentalLine.mock.calls.at(-1)![1] as { extensionChargePence: number }).extensionChargePence;
    expect(extensionOf().chargePence).toBe(added);
    expect(added).toBe(110_000);
  });

  // BOTH figures, so a negotiated extension shows what the rate said and what was actually agreed —
  // the gap between them is the discount, and it is invisible from either number alone.
  it("keeps what the rate calculated beside what was agreed", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "day", ratePence: 5_500, quantity: 1 }));
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-11", additionalChargePence: 40_000 }, ACTOR);
    expect(extensionOf()).toMatchObject({
      chargePence: 40_000,
      calculatedChargePence: 55_000,
      priceOverridden: true,
    });
  });

  it("does not call it negotiated when the agreed figure is what the rate said", async () => {
    findRentalLine.mockResolvedValue(line({ ratePeriod: "day", ratePence: 5_500, quantity: 1 }));
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-11", additionalChargePence: 55_000 }, ACTOR);
    expect(extensionOf().priceOverridden).toBe(false);
  });

  it("stamps who agreed it", async () => {
    findRentalLine.mockResolvedValue(line());
    await extendHire(PO_ID, "l1", { hireEndDate: "2026-10-11" }, ACTOR);
    expect(extensionOf().createdBy).toBe("pm@x.co");
  });
});

// Extensions agreed BEFORE this was recorded per event have no breakdown row, and none is invented —
// the audit metadata identifies its hire only by item name. Stated rather than hidden: a breakdown
// silently adding up to less than the total beside it reads as the total being wrong.
describe("extensions recorded before the breakdown existed", () => {
  const orderWithHire = (extensionChargePence: number, extensions: { chargePence: number }[]) =>
    ({
      ...(poRow() as unknown as Record<string, unknown>),
      rentalItems: [
        {
          id: "l1",
          rentalItemId: "r1",
          itemName: "Fibre Tester",
          baseUnit: null,
          quantity: 1,
          hireStartDate: new Date("2026-09-01T00:00:00Z"),
          hireEndDate: new Date("2026-10-01T00:00:00Z"),
          notifyDaysBefore: 3,
          notifyOnDate: new Date("2026-09-28T00:00:00Z"),
          deliveryAddress: null,
          returnMode: "delivery",
          returnAddress: null,
          ratePeriod: "total",
          ratePence: null,
          priceOverridden: false,
          unitPricePence: 0,
          vatRate: 0,
          lineTotalPence: 0,
          notes: null,
          hireStatus: "on_hire",
          receivedQuantity: 1,
          fullyReceived: true,
          returnedQuantity: 0,
          fullyReturned: false,
          damagedQuantity: 0,
          receivedAt: null,
          receivedBy: null,
          returnedAt: null,
          returnedBy: null,
          extensionChargePence,
          extensions: extensions.map((e, i) => ({
            id: `e${i}`,
            previousEndDate: new Date("2026-09-20T00:00:00Z"),
            newEndDate: new Date("2026-10-01T00:00:00Z"),
            addedDays: 11,
            chargePence: e.chargePence,
            calculatedChargePence: e.chargePence,
            priceOverridden: false,
            createdBy: "pm@x.co",
            createdAt: new Date("2026-09-15T09:00:00Z"),
          })),
          rentalItem: null,
        },
      ],
    }) as never;

  it("shows the unexplained remainder rather than a breakdown that does not add up", async () => {
    findById.mockResolvedValue(orderWithHire(72_500, [{ chargePence: 30_000 }]));
    const po = await getPurchaseOrder(PO_ID, ACTOR);
    expect(po.rentalItems[0].extensionCharge).toBe(725);
    expect(po.rentalItems[0].extensions).toHaveLength(1);
    expect(po.rentalItems[0].unexplainedExtensionCharge).toBe(425);
  });

  it("has nothing unexplained once every extension is on file", async () => {
    findById.mockResolvedValue(orderWithHire(72_500, [{ chargePence: 30_000 }, { chargePence: 42_500 }]));
    const po = await getPurchaseOrder(PO_ID, ACTOR);
    expect(po.rentalItems[0].unexplainedExtensionCharge).toBe(0);
  });

  // Never negative: a total the rows overshoot is bad data, and a "-£20 unexplained" chip is noise
  // on a screen where every other number is money owed.
  it("never reports a negative remainder", async () => {
    findById.mockResolvedValue(orderWithHire(30_000, [{ chargePence: 42_500 }]));
    const po = await getPurchaseOrder(PO_ID, ACTOR);
    expect(po.rentalItems[0].unexplainedExtensionCharge).toBe(0);
  });
});

describe("markHireReturned — the receive step comes first", () => {
  // Nothing can go back that never arrived. Stamping a return date onto kit that was never in our
  // hands would put a returnedAt on a hire that never started; the honest answer is to refuse.
  it("refuses to return a hire that has not been received", async () => {
    findRentalLine.mockResolvedValue(line({ hireStatus: "awaiting_delivery" }));
    await expect(markHireReturned(PO_ID, "l1", ACTOR)).rejects.toThrow(/hasn't been received yet/i);
    expect(updateRentalLine).not.toHaveBeenCalled();
  });
});

describe("extendHire — an unreceived hire can still move", () => {
  // Dates change before delivery all the time: the provider slips a week, the job moves. Extending is
  // about the PERIOD, not about possession, so it must not require the kit to have arrived.
  it("extends a hire that is still awaiting delivery", async () => {
    findRentalLine.mockResolvedValue(line({ hireStatus: "awaiting_delivery" }));
    await expect(
      extendHire(PO_ID, "l1", { hireEndDate: new Date("2026-10-14T00:00:00Z") } as never, ACTOR),
    ).resolves.toBeDefined();
    expect(extendRentalLine).toHaveBeenCalled();
  });
});

// A hire receipt DERIVES the order's received status and writes it without `assertTransition` — it is
// not a command, it is arithmetic. That makes it the one write that has to ask the state machine's
// question itself.
describe("recomputeRentalReceiptStatus respects the order's state machine", () => {
  const order = (status: string, over: Record<string, unknown> = {}) =>
    ({
      id: PO_ID,
      code: "PO-0063",
      status,
      items: [],
      rentalItems: [{ quantity: 3, receivedQuantity: 3 }],
      ...over,
    }) as never;

  beforeEach(() => {
    vi.mocked(poRepo.update).mockResolvedValue({ id: PO_ID, code: "PO-0063", status: "fully_received" } as never);
  });

  // A PRF-born order sits in DRAFT while its committed kit turns up, and the receiving queue lists it
  // on purpose. What must not follow is the order jumping to `fully_received`: there is no path from
  // there back to `sent`, so it could never be issued, the supplier would never get it, and closing it
  // would be the only move left. Silently, with nobody told.
  it("does not move a draft order", async () => {
    findById.mockResolvedValue(order("draft"));
    await recomputeRentalReceiptStatus(PO_ID, ACTOR);
    expect(poRepo.update).not.toHaveBeenCalled();
  });

  it("does not move an order still awaiting approval", async () => {
    for (const status of ["pending_approval", "approved", "pm_review"]) {
      vi.mocked(poRepo.update).mockClear();
      findById.mockResolvedValue(order(status));
      await recomputeRentalReceiptStatus(PO_ID, ACTOR);
      expect(poRepo.update, status).not.toHaveBeenCalled();
    }
  });

  // Once the order IS issued, the quantities recorded while it was a draft catch up.
  it("moves an issued order", async () => {
    findById.mockResolvedValue(order("sent"));
    await recomputeRentalReceiptStatus(PO_ID, ACTOR);
    expect(poRepo.update).toHaveBeenCalledWith(PO_ID, { status: "fully_received" });
  });
});

// REVERSING a delivery is the one operation that takes received quantity AWAY, so it is the one that
// has to be able to walk the order's status back.
describe("a reversal can move the receipt status backwards", () => {
  const reversed = (status: string, over: Record<string, unknown> = {}) =>
    ({
      id: PO_ID,
      code: "PO-0066",
      status,
      items: [],
      // Every unit given back: the delivery that recorded them no longer stands.
      rentalItems: [{ quantity: 3, receivedQuantity: 0 }],
      ...over,
    }) as never;

  beforeEach(() => {
    vi.mocked(poRepo.update).mockResolvedValue({ id: PO_ID, code: "PO-0066", status: "sent" } as never);
  });

  // Without this the order kept saying `fully_received` with nothing received — and an order outside
  // the receiving window shows no Receive button and reaches no warehouse queue, so the units it had
  // just given back appeared nowhere at all.
  it("takes a fully-received order back to sent when nothing is left received", async () => {
    findById.mockResolvedValue(reversed("fully_received"));
    await recomputeRentalReceiptStatus(PO_ID, ACTOR, { allowDowngrade: true });
    expect(poRepo.update).toHaveBeenCalledWith(PO_ID, { status: "sent" });
  });

  // An order the supplier acknowledged does not un-acknowledge itself: it goes back to where it stood
  // before the first delivery landed.
  it("goes back to supplier_accepted when there is an acceptance on file", async () => {
    findById.mockResolvedValue(reversed("fully_received", { supplierAcceptedAt: new Date("2026-08-19T00:00:00Z") }));
    await recomputeRentalReceiptStatus(PO_ID, ACTOR, { allowDowngrade: true });
    expect(poRepo.update).toHaveBeenCalledWith(PO_ID, { status: "supplier_accepted" });
  });

  it("drops to partially_received when some of it still stands", async () => {
    findById.mockResolvedValue(reversed("fully_received", { rentalItems: [{ quantity: 3, receivedQuantity: 1 }] }));
    await recomputeRentalReceiptStatus(PO_ID, ACTOR, { allowDowngrade: true });
    expect(poRepo.update).toHaveBeenCalledWith(PO_ID, { status: "partially_received" });
  });

  // Every OTHER caller only ever adds quantity, so a downgrade from one of them would be a bug, not
  // a correction — it stays refused by default.
  it("refuses to move backwards for any caller that did not ask", async () => {
    findById.mockResolvedValue(reversed("fully_received"));
    await recomputeRentalReceiptStatus(PO_ID, ACTOR);
    expect(poRepo.update).not.toHaveBeenCalled();
  });

  // Its own audit action: the order was not re-sent, its receipts were undone.
  it("records the reversal under its own action, with both statuses", async () => {
    findById.mockResolvedValue(reversed("fully_received"));
    await recomputeRentalReceiptStatus(PO_ID, ACTOR, { allowDowngrade: true });
    const entry = vi.mocked(audit.record).mock.calls.map((c) => c[0]).find((e) => e.action === "purchase_order.receipt_reverted");
    expect(entry).toBeTruthy();
    expect(entry!.metadata).toMatchObject({ from: "fully_received", to: "sent" });
  });

  // Terminal states stay terminal — a reversal cannot reopen a closed or cancelled order.
  it.each(["closed", "cancelled"])("leaves a %s order alone", async (status) => {
    findById.mockResolvedValue(reversed(status));
    await recomputeRentalReceiptStatus(PO_ID, ACTOR, { allowDowngrade: true });
    expect(poRepo.update).not.toHaveBeenCalled();
  });
});

// `returnedQuantity` has ONE writer once notes exist: the return notes themselves. Reversing a note
// recomputes that column purely from the notes that survive, so a quantity written here with no note
// behind it would be erased by the next reversal — a 2-unit note reversed after this closed a 5-unit
// hire would wipe all five and reopen it as if nothing ever went back.
describe("markHireReturned refuses to write over note-backed returns", () => {
  it("refuses when units have already gone back on a record", async () => {
    findById.mockResolvedValue({ id: PO_ID, code: "PO-0063", status: "sent", deletedAt: null } as never);
    vi.mocked(poRepo.findRentalLine).mockResolvedValue({
      id: "l1",
      purchaseOrderId: PO_ID,
      itemName: "Fibre Tester",
      hireStatus: "on_hire",
      receivedQuantity: 5,
      returnedQuantity: 2,
      hireEndDate: new Date("2026-10-01T00:00:00Z"),
    } as never);
    await expect(markHireReturned(PO_ID, "l1", ACTOR)).rejects.toThrow(/already has collection records/i);
    expect(poRepo.updateRentalLine).not.toHaveBeenCalled();
  });
});

// An order whose hired equipment is still in our hands is not finished — the supplier is still
// billing for it, and it still has to go back.
describe("closing waits for the equipment to come back", () => {
  const DAY = new Date("2026-08-20T00:00:00Z");
  const RETURNED_LINE = {
    itemName: "Fibre Tester",
    hireStatus: "returned",
    hireStartDate: DAY,
    hireEndDate: DAY,
    notifyOnDate: DAY,
    quantity: 1,
    deliveryLocation: null,
    returnLocation: null,
  };

  // The relations `toPublic` walks on the way back out — a close returns the whole order.
  const order = (rentalItems: unknown[], status = "fully_received") =>
    ({
      id: PO_ID,
      code: "PO-0063",
      status,
      deletedAt: null,
      items: [],
      rentalItems,
      attachments: [],
      goodsReceipts: [],
      // The three dates `toPublic` reads without a null guard.
      orderDate: DAY,
      createdAt: DAY,
      updatedAt: DAY,
    }) as never;

  // Closing is also a ONE-WAY DOOR: the return and damage paths refuse a closed order, so a hire
  // closed out from under would have no way left to record its handover, while the deadline badges
  // kept counting it.
  it("refuses while a hire is still out", async () => {
    findById.mockResolvedValue(order([{ itemName: "Fibre Tester", hireStatus: "on_hire" }]));
    await expect(closePurchaseOrder(PO_ID, ACTOR)).rejects.toThrow(/still on hire/i);
    expect(poRepo.update).not.toHaveBeenCalled();
  });

  it("refuses while a hire has not even arrived", async () => {
    findById.mockResolvedValue(order([{ itemName: "Fibre Tester", hireStatus: "awaiting_delivery" }]));
    await expect(closePurchaseOrder(PO_ID, ACTOR)).rejects.toThrow(/still on hire/i);
  });

  it("closes once every hire has gone back", async () => {
    findById.mockResolvedValue(order([RETURNED_LINE]));
    vi.mocked(poRepo.update).mockResolvedValue(order([RETURNED_LINE], "closed"));
    await closePurchaseOrder(PO_ID, ACTOR);
    expect(poRepo.update).toHaveBeenCalledWith(PO_ID, expect.objectContaining({ status: "closed" }));
  });

  // An order with no hires at all is untouched by this — it is the goods-only path.
  it("leaves a goods-only order alone", async () => {
    findById.mockResolvedValue(order([]));
    vi.mocked(poRepo.update).mockResolvedValue(order([RETURNED_LINE], "closed"));
    await closePurchaseOrder(PO_ID, ACTOR);
    expect(poRepo.update).toHaveBeenCalled();
  });
});

// The supplier's acknowledgement can arrive after the van does — the PO flow allows a late one on
// purpose. What it must not do is demand a forward-looking promise about a delivery that has already
// happened.
describe("the confirmed delivery date is required only while the delivery is still ahead", () => {
  const DAY2 = new Date("2026-08-20T00:00:00Z");
  const order = (status: string) =>
    ({
      id: PO_ID,
      code: "PO-0066",
      status,
      deletedAt: null,
      items: [],
      rentalItems: [],
      attachments: [],
      goodsReceipts: [],
      orderDate: DAY2,
      createdAt: DAY2,
      updatedAt: DAY2,
    }) as never;

  beforeEach(() => {
    vi.mocked(poRepo.update).mockImplementation(async (_id: string, data: Record<string, unknown>) =>
      ({ ...(order((data.status as string) ?? "sent") as object), ...data }) as never,
    );
  });

  it.each(["sent", "supplier_accepted"])("refuses a missing date on a %s order", async (status) => {
    findById.mockResolvedValue(order(status));
    await expect(recordSupplierAcceptance(PO_ID, {} as never, ACTOR)).rejects.toThrow(/delivery date the supplier confirmed/i);
    expect(poRepo.update).not.toHaveBeenCalled();
  });

  // Once the goods are in there is nothing left to plan against, and the real arrival is already on
  // the receipt. Insisting here would push somebody to type the date it actually turned up — filing
  // an arrival under a field that means "what the supplier promised".
  it.each(["partially_received", "fully_received"])("accepts a missing date on a %s order", async (status) => {
    findById.mockResolvedValue(order(status));
    await recordSupplierAcceptance(PO_ID, { supplierAckReference: "ACK-9" } as never, ACTOR);
    expect(poRepo.update).toHaveBeenCalled();
  });

  // A late acknowledgement must not ERASE the date the supplier committed to earlier in the order's
  // life — leaving it blank means "nothing new to say", not "there was never one".
  it("leaves an existing confirmed date alone when none is given", async () => {
    findById.mockResolvedValue(order("fully_received"));
    await recordSupplierAcceptance(PO_ID, {} as never, ACTOR);
    const [, data] = vi.mocked(poRepo.update).mock.calls[0]!;
    expect(data).not.toHaveProperty("confirmedDeliveryDate");
  });

  it("still records a date when one is given", async () => {
    findById.mockResolvedValue(order("fully_received"));
    await recordSupplierAcceptance(PO_ID, { confirmedDeliveryDate: "2026-08-21" } as never, ACTOR);
    const [, data] = vi.mocked(poRepo.update).mock.calls[0]!;
    expect(data.confirmedDeliveryDate).toEqual(new Date("2026-08-21"));
  });
});
