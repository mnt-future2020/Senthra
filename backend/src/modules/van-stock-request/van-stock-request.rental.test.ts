import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An engineer collecting HIRED kit through Field Stock — the non-job door onto the rental pool.
//
// The rule this suite exists to hold is the LIFECYCLE, not any one guard: a hire that can go out must
// be able to come back. The job-return path matches on a job kit line, and a Field Stock issue has
// none, so without the return leg here every unit collected this way would sit "issued" forever —
// un-returnable to the provider and still billing. Issue and return are therefore tested as one story.
//
// Everything else follows the Job Kit Request rental rules unchanged: availability is free-on-hire net
// of what jobs have planned, the hire is bound at the scan and never at the request, an expired hire
// cannot go out but must still come back, and damage on a hire is EVIDENCE against the provider
// (HireCustodyExit) rather than a write-off of stock we own (DamagedStockBalance).

vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/notification/notification.service.js", () => ({ notify: vi.fn() }));
vi.mock("../../lib/realtime.js", () => ({
  emitAttentionChanged: vi.fn(), emitToUser: vi.fn(), emitToRoom: vi.fn(), VAN_STOCK_REVIEWERS_ROOM: "vsr:reviewers",
  // The room rentalHire.realtime broadcasts hire updates on — pulled in now that a Field Stock
  // posting announces the hire counters it moved.
  RENTAL_WATCHERS_ROOM: "rental:watchers",
}));
vi.mock("../../lib/cloudinary.js", () => ({ uploadToCloudinary: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({
  getCloudinaryCreds: vi.fn(), getCompanyTimezone: vi.fn(async () => "Europe/London"),
}));
vi.mock("#modules/irm/irm.repository.js", () => ({ findById: vi.fn(), findMany: vi.fn(async () => []) }));
vi.mock("#modules/irm/irm.service.js", () => ({ findActiveByCodeOrBarcode: vi.fn(async () => null) }));
vi.mock("#modules/rental-item/rental-item.repository.js", () => ({
  findById: vi.fn(), findActiveByCode: vi.fn(), findByCodeAnyStatus: vi.fn(), findManyByIds: vi.fn(async () => []),
  findMany: vi.fn(async () => ({ items: [], total: 0 })),
}));
vi.mock("#modules/engineer-rental/engineer-rental.repository.js", () => ({
  findRentalHoldingsByEngineer: vi.fn(async () => []), upsertRentalHoldingTx: vi.fn(), insertRentalTxnTx: vi.fn(),
  findRentalHoldingTx: vi.fn(async () => null),
  // The FIELD-door net per hire, read inside the posting transaction. Defaulted generously in
  // beforeEach because every fixture in this file is kit the engineer collected through Field Stock —
  // origin is not what those tests are about. The origin suite at the end sets it explicitly.
  findFieldOriginByHiresTx: vi.fn(async () => new Map<string, number>()),
  // The non-tx twin, read for SELECTION (create depot guard, posting allocator candidates, myHoldings
  // depots) so the allocator binds field-origin hires and create/read never overstate a job-origin depot.
  findFieldOriginByHires: vi.fn(async () => new Map<string, number>()),
}));
vi.mock("#modules/purchase-order/purchase-order.repository.js", () => ({
  findIssuableHiresByRentalItems: vi.fn(async () => []), findLiveHiresByRentalItems: vi.fn(async () => []),
  findHireStockByIdTx: vi.fn(), adjustHireIssuedQtyTx: vi.fn(async () => true),
  // Where each held hire came from — the create-time depot guard's one batched read.
  findHireDepotsByIds: vi.fn(async () => []),
}));
vi.mock("#modules/purchase-order/hireCustodyExit.repository.js", () => ({
  createExitTx: vi.fn(), CUSTODY_HELD_DAMAGED: "held_damaged",
}));
vi.mock("#modules/goods-management/goods-management.service.js", () => ({
  getOpenDemand: vi.fn(async () => new Map()), jobCommittedByEngineer: vi.fn(async () => new Map()),
  rentalCommittedByEngineer: vi.fn(async () => new Map()),
  // Both committed pools from one job+movement read — what VSR now calls where it used to call
  // the two single-pool readers side by side.
  committedByEngineer: vi.fn(async () => ({ irm: new Map(), rental: new Map(), rentalFieldByHire: new Map() })),
}));
vi.mock("#modules/goods-management/goods-management.repository.js", () => ({
  upsertDamagedBalanceTx: vi.fn(), insertDamagedTxnTx: vi.fn(),
}));
vi.mock("#modules/engineer-stock/engineer-stock.repository.js", () => ({
  findEngineerBalances: vi.fn(async () => []), findEngineerBalance: vi.fn(async () => null),
  upsertEngineerBalanceTx: vi.fn(), insertEngineerTxnTx: vi.fn(),
}));
vi.mock("#modules/inventory/inventory.repository.js", () => ({
  findBalancesByItemsAndWarehouses: vi.fn(async () => []), findBalancePair: vi.fn(async () => null),
}));
vi.mock("#modules/inventory/inventory.service.js", () => ({ applyOutbound: vi.fn(), applyInbound: vi.fn() }));
vi.mock("#modules/user/user.repository.js", () => ({ findById: vi.fn() }));
vi.mock("#modules/warehouse/warehouse.repository.js", () => ({ findById: vi.fn(), findMany: vi.fn(async () => []) }));
// The repository's CANONICAL line math (lineRemaining / lineDone) stays REAL — the service delegates
// to it deliberately, and a test that re-implemented the arithmetic could agree with a bug.
vi.mock("./van-stock-request.repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./van-stock-request.repository.js")>();
  return {
    ...actual,
    findById: vi.fn(), createRequest: vi.fn(), postFulfilment: vi.fn(),
    claimLinesForReview: vi.fn(), findOpenLineItems: vi.fn(async () => []),
  };
});

import * as rentalItemRepo from "#modules/rental-item/rental-item.repository.js";
import * as rentalCustodyRepo from "#modules/engineer-rental/engineer-rental.repository.js";
import * as poRepo from "#modules/purchase-order/purchase-order.repository.js";
import * as custodyExitRepo from "#modules/purchase-order/hireCustodyExit.repository.js";
import * as gmService from "#modules/goods-management/goods-management.service.js";
import * as gmRepo from "#modules/goods-management/goods-management.repository.js";
import * as userRepo from "#modules/user/user.repository.js";
import * as warehouseRepo from "#modules/warehouse/warehouse.repository.js";
import * as irmRepo from "#modules/irm/irm.repository.js";
import * as irmService from "#modules/irm/irm.service.js";
import * as inventoryRepo from "#modules/inventory/inventory.repository.js";
import * as engineerStockRepo from "#modules/engineer-stock/engineer-stock.repository.js";
import * as settings from "#modules/settings/settings.service.js";
import * as realtime from "../../lib/realtime.js";
import * as vsrRepo from "./van-stock-request.repository.js";
import { approve, availability, create, fulfil, myHoldings, scanLookup, searchRequestableItems, searchWarehouseItems, walkIn } from "./van-stock-request.service.js";

const RENTAL = "d".repeat(24);
const RENTAL_2 = "e".repeat(24);
const IRM = "c".repeat(24);
const ENG = "e1".padEnd(24, "0");
const WH = "w1".padEnd(24, "0");
const OTHER_WH = "w2".padEnd(24, "0");
const REQ_ID = "r".repeat(24);
const LINE_ID = "l1".padEnd(24, "0");
const HIRE_SOON = "h1".padEnd(24, "0"); // due first — must be drained first
const HIRE_LATER = "h2".padEnd(24, "0");
const PO_ID = "9".repeat(24);
const FULFILMENT_ID = "f1".padEnd(24, "0");

// An unrestricted reviewer (no assignedWarehouseIds ⇒ every warehouse). Scoped actors are built
// explicitly in the access tests below.
const admin = { id: "u".repeat(24), email: "wh@x.com", type: "admin", permissions: ["*"] } as never;
const engineerActor = { id: ENG, email: "fe@x.com", type: "user" } as never;

const RENTAL_ITEM = { id: RENTAL, code: "RNT-0007", name: "Fibre Tester", baseUnit: "Each", status: "active", deletedAt: null };

const hire = (over: Record<string, unknown> = {}) => ({
  id: HIRE_SOON, rentalItemId: RENTAL, itemName: "Fibre Tester", baseUnit: "Each",
  quantity: 3, receivedQuantity: 3, returnedQuantity: 0, issuedQuantity: 0, lostQuantity: 0, fieldDamageQty: 0,
  hireEndDate: new Date("2026-12-01T00:00:00Z"), hireStatus: "on_hire",
  purchaseOrderId: PO_ID, poCode: "PO-0042",
  warehouseId: WH, warehouseName: "Leeds", warehouseCode: "LDS", orderLive: true,
  ...over,
});

const holding = (over: Record<string, unknown> = {}) => ({
  purchaseOrderRentalLineId: HIRE_SOON, rentalItemId: RENTAL, quantityOnHand: 2,
  hireEndDate: new Date("2026-12-01T00:00:00Z"), poCode: "PO-0042", itemName: "Fibre Tester",
  ...over,
});

/**
 * Stage the FIELD-door net per hire as the posting transaction will read it: `van_restock − van_return`
 * from the custody ledger. A hire absent from the map reads as 0 — no field-door history at all.
 */
const fieldOriginTx = (byHire: Record<string, number>) =>
  vi.mocked(rentalCustodyRepo.findFieldOriginByHiresTx).mockImplementation(
    (async (_tx: unknown, _eng: string, ids: string[]) => new Map(Object.entries(byHire).filter(([id]) => ids.includes(id)))) as never,
  );

/** The non-tx field-door net, staged for SELECTION (create guard, allocator candidates, myHoldings). */
const fieldOrigin = (byHire: Record<string, number>) =>
  vi.mocked(rentalCustodyRepo.findFieldOriginByHires).mockImplementation(
    (async (_eng: string, ids: string[]) => new Map(Object.entries(byHire).filter(([id]) => ids.includes(id)))) as never,
  );

const rentalLine = (over: Record<string, unknown> = {}) => ({
  id: LINE_ID, requestId: REQ_ID, source: "rental", irmItemId: null, rentalItemId: RENTAL,
  itemName: "Fibre Tester", code: "RNT-0007", sku: null, uom: "Each",
  requestedQty: 2, approvedQty: 2, fulfilledQty: 0,
  sourceWarehouseId: WH, sourceWarehouseName: "Leeds", sourceWarehouseCode: "LDS", sourceWarehouse: null,
  reviewedByEmail: null, reviewedAt: null, decisionNote: null,
  closedShortQty: null, closedShortBy: null, closedShortNote: null, closedShortAt: null,
  cancelledQty: null, cancelledBy: null, cancelledAt: null, createdAt: new Date("2026-08-27T00:00:00Z"),
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  id: REQ_ID, code: "VSR-0031", type: "restock", status: "approved", priority: "normal",
  createdVia: "engineer_request", engineerId: ENG, engineerName: "Kansha M", engineerEmail: "fe@x.com",
  preferredWarehouseId: WH, preferredWarehouseName: "Leeds", preferredWarehouseCode: "LDS",
  warehouseId: WH, warehouseName: "Leeds", warehouseCode: "LDS",
  reason: "field spares", notes: null, attachments: [],
  reviewedByUserId: null, reviewedByEmail: null, reviewedAt: null, decisionNote: null,
  lastFulfilledAt: null, completionType: null, closedShortBy: null, closedShortAt: null,
  closeShortNote: null, cancelledAt: null, deletedAt: null, createdBy: null,
  createdAt: new Date("2026-08-27T00:00:00Z"), updatedAt: new Date("2026-08-27T00:00:00Z"),
  lines: [rentalLine()], fulfilments: [],
  ...over,
});

type PostFulfilmentArgs = Parameters<typeof vsrRepo.postFulfilment>;
type PostedEntries = PostFulfilmentArgs[3];
type ApplyFn = PostFulfilmentArgs[4];

/**
 * Stand in for the posting transaction and capture what it would have written: the fulfilment rows,
 * and — by running the real `apply` against a stub tx — every ledger call it makes.
 *
 * `FULFILMENT_ID` is handed to apply the way the repository hands it the row it just created, which
 * is what lets the damage-idempotency tests below assert on the key the exit is actually written with.
 */
async function runFulfil(req: ReturnType<typeof request>, input: Record<string, unknown>, actor: unknown = admin) {
  vi.mocked(vsrRepo.findById).mockResolvedValue(req as never);
  let posted: PostedEntries = [];
  vi.mocked(vsrRepo.postFulfilment).mockImplementation(
    (async (_id: string, _allowed: string[], _by: string, entries: PostedEntries, apply: ApplyFn) => {
      posted = entries;
      await apply({} as never, req as never, FULFILMENT_ID);
      return { ...req, status: "fulfilled" };
    }) as never,
  );
  await fulfil(REQ_ID, input as never, actor as never);
  return posted;
}

beforeEach(() => {
  // clearAllMocks wipes CALL HISTORY but keeps implementations, so every default a test overrides has
  // to be restated here or it leaks into the next one — which is exactly how a suite starts asserting
  // against a neighbour's fixture and passing for the wrong reason.
  vi.clearAllMocks();
  vi.mocked(gmService.getOpenDemand).mockResolvedValue(new Map() as never);
  vi.mocked(gmService.jobCommittedByEngineer).mockResolvedValue(new Map() as never);
  vi.mocked(gmService.rentalCommittedByEngineer).mockResolvedValue(new Map() as never);
  // Every fixture hire is field-collected kit, so the field-per-hire map (now returned by
  // committedByEngineer and reused by the depot guard / holdings depots) covers them generously.
  // Job-committed origin tests override it explicitly.
  vi.mocked(gmService.committedByEngineer).mockResolvedValue({ irm: new Map(), rental: new Map(), rentalFieldByHire: new Map([[HIRE_SOON, 99], [HIRE_LATER, 99]]) } as never);
  vi.mocked(irmService.findActiveByCodeOrBarcode).mockResolvedValue(null as never);
  vi.mocked(inventoryRepo.findBalancePair).mockResolvedValue(null as never);
  vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([] as never);
  vi.mocked(rentalItemRepo.findMany).mockResolvedValue({ items: [], total: 0 } as never);
  vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([] as never);
  vi.mocked(rentalItemRepo.findById).mockResolvedValue(RENTAL_ITEM as never);
  vi.mocked(rentalItemRepo.findActiveByCode).mockResolvedValue(RENTAL_ITEM as never);
  vi.mocked(rentalItemRepo.findByCodeAnyStatus).mockResolvedValue(RENTAL_ITEM as never);
  vi.mocked(rentalItemRepo.findManyByIds).mockResolvedValue([RENTAL_ITEM] as never);
  vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire()] as never);
  vi.mocked(poRepo.findLiveHiresByRentalItems).mockResolvedValue([hire()] as never);
  vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue(hire() as never);
  // Both fixture hires live at WH by default, so the depot guard is satisfied unless a test says otherwise.
  vi.mocked(poRepo.findHireDepotsByIds).mockResolvedValue([
    { id: HIRE_SOON, rentalItemId: RENTAL, warehouseId: WH, warehouseName: "Leeds" },
    { id: HIRE_LATER, rentalItemId: RENTAL, warehouseId: WH, warehouseName: "Leeds" },
  ] as never);
  vi.mocked(poRepo.adjustHireIssuedQtyTx).mockResolvedValue(true as never);
  vi.mocked(rentalCustodyRepo.upsertRentalHoldingTx).mockResolvedValue({ quantityOnHand: 2 } as never);
  vi.mocked(rentalCustodyRepo.findRentalHoldingTx).mockResolvedValue(holding() as never);
  // Every hire in these fixtures was collected through Field Stock, so the field door covers whatever
  // the test returns. Deliberately larger than any fixture quantity: the origin guard is exercised
  // where it belongs, in "the origin invariant at posting time" below.
  fieldOriginTx({ [HIRE_SOON]: 99, [HIRE_LATER]: 99 });
  // Same generous default for the non-tx selection read — every fixture here is field-collected kit, so
  // capping candidates/depots at field-origin is a no-op unless a test states a mixed origin.
  fieldOrigin({ [HIRE_SOON]: 99, [HIRE_LATER]: 99 });
  vi.mocked(warehouseRepo.findById).mockResolvedValue({ id: WH, name: "Leeds", code: "LDS", status: "active" } as never);
  vi.mocked(warehouseRepo.findMany).mockResolvedValue([{ id: WH, name: "Leeds", code: "LDS", status: "active" }] as never);
  vi.mocked(userRepo.findById).mockResolvedValue({ id: ENG, firstName: "Kansha", lastName: "M", email: "fe@x.com", status: "active", role: { canHoldStock: true } } as never);
  vi.mocked(vsrRepo.createRequest).mockResolvedValue(request({ status: "pending" }) as never);
  vi.mocked(vsrRepo.claimLinesForReview).mockResolvedValue(request() as never);
});

// ── 1–2. Requesting hired kit ────────────────────────────────────────────────────────────────────

describe("create — asking for hired kit", () => {
  it("snapshots the catalogue item and carries the rental id", async () => {
    await create(
      { type: "restock", reason: "field spares", priority: "normal", lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 2, warehouseId: WH }] } as never,
      engineerActor,
    );
    const [, lines] = vi.mocked(vsrRepo.createRequest).mock.calls[0]!;
    expect(lines[0]).toMatchObject({ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", requestedQty: 2 });
    // The rental id must NOT leak into the IRM socket — a line carrying both would move company stock.
    expect(lines[0]!.irmItemId).toBeUndefined();
    // No SKU on a hire master by design; the code takes its place and is what the label encodes.
    expect(lines[0]!.code).toBe("RNT-0007");
    expect(lines[0]!.sku).toBeNull();
  });

  it("refuses a retired rental item", async () => {
    vi.mocked(rentalItemRepo.findById).mockResolvedValue({ ...RENTAL_ITEM, status: "inactive" } as never);
    await expect(
      create({ type: "restock", reason: "x", priority: "normal", lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1, warehouseId: WH }] } as never, engineerActor),
    ).rejects.toThrow(/is not active/i);
  });

  // 22. A crafted id that resolves to nothing must be refused, not silently persisted as a snapshot.
  it("refuses a rental id that resolves to no catalogue item", async () => {
    vi.mocked(rentalItemRepo.findById).mockResolvedValue(null as never);
    await expect(
      create({ type: "restock", reason: "x", priority: "normal", lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Made Up", qty: 1, warehouseId: WH }] } as never, engineerActor),
    ).rejects.toThrow(/no longer exists/i);
  });
});

// ── 3–5. Availability ────────────────────────────────────────────────────────────────────────────

describe("availability — free on hire, net of what jobs have planned", () => {
  it("is scoped to the depot that actually holds the hire", async () => {
    // The hire is delivered to WH. Approving against OTHER_WH must find nothing there.
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockImplementation((async (_ids: string[], _t: Date, whIds?: string[]) =>
      !whIds || whIds.includes(WH) ? [hire()] : []) as never);
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ status: "pending", lines: [rentalLine({ approvedQty: null, sourceWarehouseId: OTHER_WH })] }) as never);
    vi.mocked(warehouseRepo.findById).mockResolvedValue({ id: OTHER_WH, name: "York", code: "YRK", status: "active" } as never);
    await expect(approve(REQ_ID, { warehouseId: OTHER_WH } as never, admin)).rejects.toThrow(/only 0 free on hire/i);
  });

  // 4 + 5. A tester a job has already planned is NOT free for a field collection — the same physical
  // equipment, so the same arithmetic the job planner uses.
  it("subtracts open job demand", async () => {
    vi.mocked(gmService.getOpenDemand).mockResolvedValue(
      new Map([["rental|" + RENTAL + "|" + WH, { irmItemId: null, rentalItemId: RENTAL, customerStockEntryId: null, warehouseId: WH, itemName: "Fibre Tester", warehouseName: "Leeds", demand: 2 }]]) as never,
    );
    // 3 received, 2 planned on jobs ⇒ 1 genuinely free, so approving 2 must fail.
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ status: "pending", lines: [rentalLine({ approvedQty: null })] }) as never);
    await expect(approve(REQ_ID, { warehouseId: WH } as never, admin)).rejects.toThrow(/only 1 free on hire/i);
  });

  it("counts units already out with an engineer against the depot", async () => {
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire({ issuedQuantity: 2 })] as never);
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ status: "pending", lines: [rentalLine({ approvedQty: null })] }) as never);
    await expect(approve(REQ_ID, { warehouseId: WH } as never, admin)).rejects.toThrow(/only 1 free on hire/i);
  });

  it("excludes a unit already reported damaged", async () => {
    // Damaged kit is on the shelf and still owed to the provider, but must never go out again.
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire({ fieldDamageQty: 2 })] as never);
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ status: "pending", lines: [rentalLine({ approvedQty: null })] }) as never);
    await expect(approve(REQ_ID, { warehouseId: WH } as never, admin)).rejects.toThrow(/only 1 free on hire/i);
  });

  it("offers hired kit in the composer, flagged as rental and never as IRM", async () => {
    vi.mocked(rentalItemRepo.findMany).mockResolvedValue({ items: [RENTAL_ITEM], total: 1 } as never);
    const out = await searchRequestableItems("fibre");
    const hit = out.find((o) => o.source === "rental");
    expect(hit).toMatchObject({ rentalItemId: RENTAL, code: "RNT-0007", quantityOnHand: 3, irmItemId: null });
    // A hire never reaches the reorder engine, so it must not carry a threshold that implies it does.
    expect(hit!.reorderLevel).toBeNull();
  });

  it("still returns an item with nothing on hire, so the composer can say why", async () => {
    vi.mocked(rentalItemRepo.findMany).mockResolvedValue({ items: [RENTAL_ITEM], total: 1 } as never);
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([] as never);
    // Hidden, it would just get retyped; returned with a zero the row can be disabled and explained.
    expect((await searchRequestableItems("fibre")).find((o) => o.source === "rental")).toMatchObject({ quantityOnHand: 0 });
  });
});

// ── 6–8. Approval ────────────────────────────────────────────────────────────────────────────────

describe("approve — the rental hard-block", () => {
  it("approves a rental line against free-on-hire, never against InventoryBalance", async () => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ status: "pending", lines: [rentalLine({ approvedQty: null })] }) as never);
    await approve(REQ_ID, { warehouseId: WH } as never, admin);
    const [, approvals] = vi.mocked(vsrRepo.claimLinesForReview).mock.calls[0]!;
    expect(approvals[0]).toMatchObject({ lineId: LINE_ID, approvedQty: 2, sourceWarehouseId: WH });
    // A hire has no stock balance row; reading one would be answering the wrong question entirely.
    expect(inventoryRepo.findBalancesByItemsAndWarehouses).not.toHaveBeenCalledWith([RENTAL], expect.anything());
  });

  it("blocks more than the depot has free", async () => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ status: "pending", lines: [rentalLine({ approvedQty: null, requestedQty: 5 })] }) as never);
    await expect(approve(REQ_ID, { warehouseId: WH } as never, admin)).rejects.toThrow(/only 3 free on hire/i);
  });

  // 6. An expired hire is not issuable however many units of it stand on the shelf — the repository's
  // issuable finder is the one that enforces the window, so an empty result IS the expiry.
  it("refuses to issue from a hire whose period has ended", async () => {
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([] as never);
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ status: "pending", lines: [rentalLine({ approvedQty: null })] }) as never);
    await expect(approve(REQ_ID, { warehouseId: WH } as never, admin)).rejects.toThrow(/only 0 free on hire/i);
  });

  it("honours the reviewer's trim", async () => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ status: "pending", lines: [rentalLine({ approvedQty: null, requestedQty: 5 })] }) as never);
    await approve(REQ_ID, { warehouseId: WH, lineApprovals: [{ lineId: LINE_ID, approvedQty: 2 }] } as never, admin);
    const [, approvals] = vi.mocked(vsrRepo.claimLinesForReview).mock.calls[0]!;
    expect(approvals[0]!.approvedQty).toBe(2);
  });
});

// ── 9–12. Fulfilment binds the ACTUAL hire ───────────────────────────────────────────────────────

describe("fulfil (restock) — binding the hire and moving custody", () => {
  it("binds the actual hire and records it on the posted line", async () => {
    const posted = await runFulfil(request(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] });
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ source: "rental", rentalItemId: RENTAL, purchaseOrderRentalLineId: HIRE_SOON, poCode: "PO-0042", qty: 2 });
    // The request named a catalogue item; only the posting names a hire. The IRM socket must stay
    // empty — the repository coerces an unset id to null on write, so either form is "no IRM item",
    // and asserting on the pair keeps this true whichever way the entry is built.
    expect(posted[0]!.irmItemId ?? null).toBeNull();
  });

  // 10. Soonest deadline first is a real rule: issuing the hire with three weeks left while the one
  // due Friday sits on the shelf is how a hire goes overdue holding kit nobody was using.
  it("drains the soonest-deadline hire first, splitting across hires when it can't cover", async () => {
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([
      hire({ id: HIRE_LATER, receivedQuantity: 5, hireEndDate: new Date("2027-01-01T00:00:00Z"), poCode: "PO-0099" }),
      hire({ id: HIRE_SOON, receivedQuantity: 1, hireEndDate: new Date("2026-09-01T00:00:00Z") }),
    ] as never);
    const posted = await runFulfil(request({ lines: [rentalLine({ requestedQty: 3, approvedQty: 3 })] }), {
      warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 3, condition: "good", scannedCode: "RNT-0007" }],
    });
    // One entry became TWO posted rows — one per hire — soonest first.
    expect(posted.map((p) => [p.purchaseOrderRentalLineId, p.qty])).toEqual([[HIRE_SOON, 1], [HIRE_LATER, 2]]);
  });

  it("creates the engineer's rental holding and a van_restock ledger row", async () => {
    await runFulfil(request(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] });
    expect(rentalCustodyRepo.upsertRentalHoldingTx).toHaveBeenCalledWith(expect.anything(), HIRE_SOON, ENG, 2, expect.objectContaining({ rentalItemId: RENTAL, poCode: "PO-0042" }));
    expect(rentalCustodyRepo.insertRentalTxnTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      purchaseOrderRentalLineId: HIRE_SOON, engineerId: ENG, quantityDelta: 2,
      type: "van_restock", sourceType: "van_stock_request",
    }));
    // The hire's own issued counter moves in the same transaction — that is what makes the units
    // unavailable to anyone else.
    expect(poRepo.adjustHireIssuedQtyTx).toHaveBeenCalledWith(expect.anything(), HIRE_SOON, 2, expect.any(Date));
    // Company-stock ledgers must not be touched for a hire.
    expect(gmRepo.upsertDamagedBalanceTx).not.toHaveBeenCalled();
  });

  it("refuses to issue against an order that died between resolve and commit", async () => {
    vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue(hire({ orderLive: false }) as never);
    await expect(
      runFulfil(request(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] }),
    ).rejects.toThrow(/no longer live/i);
  });

  it("refuses when the hire's numbers moved under the posting", async () => {
    vi.mocked(poRepo.adjustHireIssuedQtyTx).mockResolvedValue(false as never);
    await expect(
      runFulfil(request(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] }),
    ).rejects.toThrow(/no longer available on this hire/i);
  });

  // 22. Identity is re-asserted inside the transaction on BOTH axes.
  it("refuses a hire belonging to a different catalogue item", async () => {
    vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue(hire({ rentalItemId: RENTAL_2 }) as never);
    await expect(
      runFulfil(request(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] }),
    ).rejects.toThrow(/different rental item/i);
  });

  it("refuses a hire belonging to a different warehouse", async () => {
    vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue(hire({ warehouseId: OTHER_WH }) as never);
    await expect(
      runFulfil(request(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] }),
    ).rejects.toThrow(/different warehouse/i);
  });
});

// ── 13–14. THE RETURN LEG — without this the whole feature is a custody leak ──────────────────────

describe("fulfil (return) — hired kit coming back", () => {
  const returnReq = (over: Record<string, unknown> = {}) =>
    request({ type: "return", status: "pending", lines: [rentalLine({ requestedQty: 2, approvedQty: 2 })], ...over });

  beforeEach(() => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    vi.mocked(rentalCustodyRepo.upsertRentalHoldingTx).mockResolvedValue({ quantityOnHand: 0 } as never);
  });

  it("resolves the bound hire from the engineer's own custody, with no job kit line involved", async () => {
    const posted = await runFulfil(returnReq(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] });
    expect(posted[0]).toMatchObject({ source: "rental", purchaseOrderRentalLineId: HIRE_SOON, qty: 2 });
  });

  it("drains custody and writes a van_return ledger row", async () => {
    await runFulfil(returnReq(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] });
    expect(rentalCustodyRepo.upsertRentalHoldingTx).toHaveBeenCalledWith(expect.anything(), HIRE_SOON, ENG, -2, expect.anything());
    expect(rentalCustodyRepo.insertRentalTxnTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      purchaseOrderRentalLineId: HIRE_SOON, quantityDelta: -2, type: "van_return", sourceType: "van_stock_request",
    }));
    // Released back into the hire's pool — WITHOUT a date argument. Asserting the hire window on the
    // way back would leave overdue kit stuck in a van with no way to record its return.
    expect(poRepo.adjustHireIssuedQtyTx).toHaveBeenCalledWith(expect.anything(), HIRE_SOON, -2);
  });

  // 7. The mirror of "an expired hire cannot be issued". These are opposite questions and the return
  // leg reads the LIVE finder precisely so an overdue hire can still come home.
  it("still accepts a return against a hire whose period has ended", async () => {
    const expired = { ...hire({ hireEndDate: new Date("2026-01-01T00:00:00Z") }) };
    vi.mocked(poRepo.findLiveHiresByRentalItems).mockResolvedValue([expired] as never);
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([] as never); // not issuable at all
    const posted = await runFulfil(returnReq(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] });
    expect(posted[0]!.purchaseOrderRentalLineId).toBe(HIRE_SOON);
  });

  it("refuses to return more than the engineer is holding", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 1 })] as never);
    await expect(
      runFulfil(returnReq(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] }),
    ).rejects.toThrow(/only holding 1/i);
  });

  // ── ORIGIN-AWARE SELECTION — the allocator must bind a FIELD-origin hire, not merely the soonest ──
  // Mixed origin, same catalogue item, same depot: H_SOON is JOB-origin (field-door 0) and due first,
  // H_LATER is FIELD-origin. The deadline-first allocator on its own binds H_SOON and the in-tx origin
  // guard then dead-ends a return the engineer can genuinely make on H_LATER. Capping candidates at
  // field-origin binds H_LATER instead. (Old behaviour: this THREW "collected through Field Stock".)
  it("binds a FIELD-origin hire over an earlier-deadline JOB-origin one (mixed origin, no dead-end)", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_SOON, quantityOnHand: 1, hireEndDate: new Date("2026-11-01T00:00:00Z") }),
      holding({ purchaseOrderRentalLineId: HIRE_LATER, quantityOnHand: 1, hireEndDate: new Date("2026-12-01T00:00:00Z") }),
    ] as never);
    vi.mocked(poRepo.findLiveHiresByRentalItems).mockResolvedValue([
      hire({ id: HIRE_SOON, warehouseId: WH }), hire({ id: HIRE_LATER, warehouseId: WH }),
    ] as never);
    vi.mocked(poRepo.findHireStockByIdTx).mockImplementation((async (_tx: unknown, id: string) => hire({ id, warehouseId: WH })) as never);
    // H_SOON came in through a job (no field-door units); H_LATER through Field Stock.
    fieldOrigin({ [HIRE_LATER]: 1 }); // selection (non-tx)
    fieldOriginTx({ [HIRE_LATER]: 1 }); // in-tx enforcement
    const posted = await runFulfil(
      returnReq({ lines: [rentalLine({ requestedQty: 1, approvedQty: 1 })] }),
      { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 1, condition: "good", scannedCode: "RNT-0007" }] },
    );
    expect(posted[0]).toMatchObject({ source: "rental", purchaseOrderRentalLineId: HIRE_LATER, qty: 1 });
  });

  // ── The return leg's IDENTITY guard ────────────────────────────────────────────────────────────
  //
  // pickReturnableHoldings deliberately falls back to a holding that is not live at the scanning
  // depot, because kit whose order was cancelled still has to be able to come home. But
  // EngineerRentalHolding carries no warehouse, so that fallback cannot tell "this depot's cancelled
  // hire" from "another depot's hire entirely" — and without the guard below, handing a tester in at
  // Leeds credited the Manchester hire: Manchester's pool gained a unit that is not on its shelf and
  // Leeds stayed short one it is physically holding. The restock leg has always asserted both axes;
  // so has Goods Management's return leg. This is the third.

  it("refuses a return whose hire belongs to another depot, rather than crediting it there", async () => {
    // The exact shape of the bug: nothing of this item is live HERE, and the engineer's only holding
    // sits on a hire delivered to another depot. The fallback duly offers it, and the posting must
    // refuse rather than silently move another warehouse's numbers.
    vi.mocked(poRepo.findLiveHiresByRentalItems).mockResolvedValue([] as never);
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ purchaseOrderRentalLineId: HIRE_LATER })] as never);
    vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue(hire({ id: HIRE_LATER, warehouseId: OTHER_WH }) as never);

    await expect(
      runFulfil(returnReq(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] }),
    ).rejects.toThrow(/collected from a different depot/i);

    // NOTHING moved. The rejection has to roll the custody drain back too, or the units vanish from
    // the engineer's van without landing anywhere.
    expect(poRepo.adjustHireIssuedQtyTx).not.toHaveBeenCalled();
  });

  it("refuses a return whose hire is for a different catalogue item", async () => {
    vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue(hire({ rentalItemId: RENTAL_2 }) as never);
    await expect(
      runFulfil(returnReq(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] }),
    ).rejects.toThrow(/different rental item/i);
    expect(poRepo.adjustHireIssuedQtyTx).not.toHaveBeenCalled();
  });

  it("refuses a return whose hire has vanished between resolve and commit", async () => {
    vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue(null as never);
    await expect(
      runFulfil(returnReq(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] }),
    ).rejects.toThrow(/no longer exists/i);
  });

  // The guard must not have narrowed what a RETURN is allowed to do. An expired hire, and one whose
  // order was cancelled, both still come home — that rule is why the return leg reads the LIVE finder
  // and asserts no `orderLive`, and it is the thing most easily broken by adding checks here.
  it("still accepts a return against a hire at this depot whose order is no longer live", async () => {
    vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue(hire({ orderLive: false, hireStatus: "returned" }) as never);
    const posted = await runFulfil(returnReq(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] });
    expect(posted[0]!.purchaseOrderRentalLineId).toBe(HIRE_SOON);
    expect(poRepo.adjustHireIssuedQtyTx).toHaveBeenCalledWith(expect.anything(), HIRE_SOON, -2);
  });

  // The counters this posting moved are what the order page and the deadline badges render.
  it("announces the hire it moved, once per purchase order, after the commit", async () => {
    await runFulfil(returnReq(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] });
    expect(realtime.emitToRoom).toHaveBeenCalledWith("rental:watchers", "rental_hire:updated", { purchaseOrderId: PO_ID, code: "PO-0042" });
    const hireEvents = vi.mocked(realtime.emitToRoom).mock.calls.filter((c) => c[1] === "rental_hire:updated");
    expect(hireEvents).toHaveLength(1);
  });

  it("announces nothing when the posting never touched a hire", async () => {
    // An IRM-only posting must stay silent on the rental channel — a spurious refresh is cheap, but a
    // consumer that learns to ignore the event because it fires for nothing is not.
    vi.mocked(engineerStockRepo.upsertEngineerBalanceTx).mockResolvedValue({ quantityOnHand: 0 } as never);
    const irmReq = request({ type: "return", status: "pending", lines: [rentalLine({ source: "irm", irmItemId: IRM, rentalItemId: null, itemName: "CAT6", requestedQty: 1, approvedQty: 1 })] });
    await runFulfil(irmReq, { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 1, condition: "good" }] });
    expect(vi.mocked(realtime.emitToRoom).mock.calls.filter((c) => c[1] === "rental_hire:updated")).toHaveLength(0);
  });
});

// ── 15–16, 18. Damage on a hire is EVIDENCE, not a write-off of our own stock ─────────────────────

describe("fulfil (return) — damaged hired kit", () => {
  const damagedReq = () => request({ type: "return", status: "pending", lines: [rentalLine({ requestedQty: 1, approvedQty: 1 })] });
  const damagedEntry = { lineId: LINE_ID, qty: 1, condition: "damaged", damagePhotoUrl: "https://x/p.jpg", damageReason: "Cracked screen", scannedCode: "RNT-0007" };

  beforeEach(() => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 1 })] as never);
    vi.mocked(rentalCustodyRepo.upsertRentalHoldingTx).mockResolvedValue({ quantityOnHand: 0 } as never);
  });

  it("opens a HireCustodyExit against the hire", async () => {
    await runFulfil(damagedReq(), { warehouseId: WH, entries: [damagedEntry] });
    expect(custodyExitRepo.createExitTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      purchaseOrderRentalLineId: HIRE_SOON, kind: "damage", qty: 1,
      custodyState: "held_damaged", reason: "Cracked screen", photoUrl: "https://x/p.jpg",
      // The HIRE's own depot owns the settlement worklist, not whichever counter took it back.
      warehouseId: WH, purchaseOrderId: PO_ID,
    }));
  });

  it("does NOT write to the damaged-stock pool", async () => {
    await runFulfil(damagedReq(), { warehouseId: WH, entries: [damagedEntry] });
    // That pool is for stock WE own. A hire is the provider's equipment and the damage is a liability
    // to them, billed once through the hire's own damage note — posting it here too double-counts it.
    expect(gmRepo.upsertDamagedBalanceTx).not.toHaveBeenCalled();
    expect(gmRepo.insertDamagedTxnTx).not.toHaveBeenCalled();
  });

  it("still releases the units back to the hire — a damaged tester is still owed to the provider", async () => {
    await runFulfil(damagedReq(), { warehouseId: WH, entries: [damagedEntry] });
    // Leaving them "issued" would make the hire un-returnable and park it on the overdue badge forever.
    expect(poRepo.adjustHireIssuedQtyTx).toHaveBeenCalledWith(expect.anything(), HIRE_SOON, -1);
  });

  // 18. THE IDEMPOTENCY TRAP. The exit is keyed [sourceType, sourceId, hire, kind]. Keyed on the
  // REQUEST, a second posting's damage on the same hire would collide with the first — and
  // createExitTx reads a collision as an idempotent retry, so those units would drain from custody
  // with no exit row holding them down, quietly returning a damaged tester to the issuable pool.
  it("keys the exit on the POSTING, so two postings on the same hire never collide", async () => {
    await runFulfil(damagedReq(), { warehouseId: WH, entries: [damagedEntry] });
    const first = vi.mocked(custodyExitRepo.createExitTx).mock.calls[0]![1];
    expect(first).toMatchObject({ sourceType: "van_stock_return", sourceId: FULFILMENT_ID });

    // A second, separate posting on the same hire — a partial return finished later.
    vi.mocked(custodyExitRepo.createExitTx).mockClear();
    const SECOND_FULFILMENT = "f2".padEnd(24, "0");
    const req2 = damagedReq();
    vi.mocked(vsrRepo.findById).mockResolvedValue(req2 as never);
    vi.mocked(vsrRepo.postFulfilment).mockImplementation(
      (async (_i: string, _a: string[], _b: string, _e: PostedEntries, apply: ApplyFn) => {
        await apply({} as never, req2 as never, SECOND_FULFILMENT);
        return { ...req2, status: "fulfilled" };
      }) as never,
    );
    await fulfil(REQ_ID, { warehouseId: WH, entries: [damagedEntry] } as never, admin);
    expect(vi.mocked(custodyExitRepo.createExitTx).mock.calls[0]![1]).toMatchObject({ sourceId: SECOND_FULFILMENT });
  });

  // Within ONE posting the key genuinely would collide, so it is refused rather than silently merged:
  // two damage reports are two reasons and two photographs.
  it("refuses two damaged entries against the same hire in one posting", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 4 })] as never);
    await expect(
      runFulfil(request({ type: "return", status: "pending", lines: [rentalLine({ requestedQty: 4, approvedQty: 4 })] }), {
        warehouseId: WH, entries: [damagedEntry, { ...damagedEntry, damageReason: "Also the case" }],
      }),
    ).rejects.toThrow(/only one damaged entry per hire/i);
  });

  it("keeps damaged COMPANY stock going to the damaged pool, unchanged", async () => {
    // The IRM leg must be untouched by any of this.
    const irmReq = request({
      type: "return", status: "pending",
      lines: [rentalLine({ source: "irm", irmItemId: IRM, rentalItemId: null, itemName: "CAT6", requestedQty: 1, approvedQty: 1 })],
    });
    vi.mocked(gmRepo.upsertDamagedBalanceTx).mockResolvedValue({ quantity: 1 } as never);
    vi.mocked(vi.mocked(await import("#modules/engineer-stock/engineer-stock.repository.js")).upsertEngineerBalanceTx).mockResolvedValue({ quantityOnHand: 0 } as never);
    await runFulfil(irmReq, { warehouseId: WH, entries: [{ ...damagedEntry, scannedCode: "IRM-0002" }] });
    expect(gmRepo.upsertDamagedBalanceTx).toHaveBeenCalled();
    expect(custodyExitRepo.createExitTx).not.toHaveBeenCalled();
  });
});

// ── 11, 19. The engineer's holdings ──────────────────────────────────────────────────────────────

describe("myHoldings — what is field-returnable", () => {
  // FOUND IN BROWSER QA. The return picker is a fixed-height scrolling list; with company stock first
  // a hire sat 432px below the fold, so an engineer holding a few IRM lines saw only IRM and read the
  // screen as "no hire to return" — while the units stayed in the van accruing charges.
  it("puts hired kit FIRST, so it can't be scrolled past", async () => {
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValue([
      { irmItemId: IRM, quantityOnHand: 5, irmItem: { code: "IRM-0002", name: "CAT6", baseUnit: "Box", trackSerialNumbers: false, trackBatchNumbers: false } },
    ] as never);
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    const out = await myHoldings(ENG);
    expect(out[0]!.source).toBe("rental");
    expect(out.map((h) => h.source)).toEqual(["rental", "irm"]);
  });

  // Soonest due (and anything already overdue) at the very top — the same "soonest deadline first"
  // rule the allocator and the return binder follow.
  it("orders hires by soonest deadline, with an undated one last", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: "h9".padEnd(24, "0"), rentalItemId: RENTAL_2, quantityOnHand: 1, hireEndDate: null, itemName: "No-date Rig" }),
      holding({ purchaseOrderRentalLineId: HIRE_LATER, rentalItemId: IRM, quantityOnHand: 1, hireEndDate: new Date("2027-01-01T00:00:00Z"), itemName: "Late Rig" }),
      holding({ quantityOnHand: 1, hireEndDate: new Date("2026-01-01T00:00:00Z"), itemName: "Overdue Rig" }),
    ] as never);
    vi.mocked(rentalItemRepo.findManyByIds).mockResolvedValue([
      { ...RENTAL_ITEM, id: RENTAL, name: "Overdue Rig" },
      { ...RENTAL_ITEM, id: IRM, code: "RNT-0100", name: "Late Rig" },
      { ...RENTAL_ITEM, id: RENTAL_2, code: "RNT-0200", name: "No-date Rig" },
    ] as never);
    const out = await myHoldings(ENG);
    expect(out.filter((h) => h.source === "rental").map((h) => h.name)).toEqual(["Overdue Rig", "Late Rig", "No-date Rig"]);
    // …and every one of them still precedes the company stock below.
    expect(out.findIndex((h) => h.source === "irm")).toBe(3);
  });

  it("lists hired kit separately, with its soonest deadline", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ quantityOnHand: 1, hireEndDate: new Date("2026-12-01T00:00:00Z") }),
      holding({ purchaseOrderRentalLineId: HIRE_LATER, quantityOnHand: 2, hireEndDate: new Date("2026-09-01T00:00:00Z"), poCode: "PO-0099" }),
    ] as never);
    const out = await myHoldings(ENG);
    const rental = out.find((h) => h.source === "rental")!;
    // Rolled up per catalogue item — that is the unit the engineer requests and returns in.
    expect(rental).toMatchObject({ rentalItemId: RENTAL, code: "RNT-0007", quantityOnHand: 3 });
    expect(rental.hireEndDate).toBe("2026-09-01T00:00:00.000Z"); // the SOONEST, not the first seen
    expect(rental.poCodes.sort()).toEqual(["PO-0042", "PO-0099"]);
  });

  // 19. Hired kit out on a job goes back through that job's own scan-in, which is what clears the
  // job's awaiting_return. Let it leave through this door and the job can never be reconciled.
  // ── The overdue flag is a CALENDAR-DAY question, answered on the company clock ─────────────────
  //
  // A hire deadline is stored at UTC midnight. Judged with `hireEndDate < Date.now()` a hire due
  // TODAY reads overdue from 00:00:01 onward, so this picker showed it red and "was due back today"
  // all day while the scan panel, which compares against companyTodayStart, said it was fine.
  // These pin the boundary itself, not just the happy path.
  describe("the overdue flag", () => {
    const dueOn = (iso: string) =>
      vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ hireEndDate: new Date(iso) })] as never);
    const overdueFlag = async () => (await myHoldings(ENG)).find((h) => h.source === "rental")!.overdue;

    // 2026-08-28, company timezone Europe/London (BST, UTC+1) — so "today" in London is already the
    // 28th while UTC is still on the 27th for the first hour. The company clock is the one that counts.
    beforeEach(() => {
      vi.setSystemTime(new Date("2026-08-28T00:30:00Z"));
      // Re-pinned per test: vi.clearAllMocks() clears CALLS, not implementations, so the Auckland
      // override below would otherwise leak into whichever test ran after it.
      vi.mocked(settings.getCompanyTimezone).mockResolvedValue("Europe/London" as never);
    });
    afterEach(() => vi.useRealTimers());

    it("does not call a hire due TODAY overdue", async () => {
      dueOn("2026-08-28T00:00:00Z");
      expect(await overdueFlag()).toBe(false);
    });

    it("calls a hire due YESTERDAY overdue", async () => {
      dueOn("2026-08-27T00:00:00Z");
      expect(await overdueFlag()).toBe(true);
    });

    it("does not call a hire due TOMORROW overdue", async () => {
      dueOn("2026-08-29T00:00:00Z");
      expect(await overdueFlag()).toBe(false);
    });

    // The decision must come from the COMPANY timezone, never the machine the code happens to run on.
    // Same instant, same hire, a company on the other side of the date line: still not overdue,
    // because it is still the 28th there too. A `Date.now()` comparison cannot express this at all.
    it("answers from the company timezone, not the process clock", async () => {
      vi.mocked(settings.getCompanyTimezone).mockResolvedValue("Pacific/Auckland" as never);
      dueOn("2026-08-28T00:00:00Z");
      expect(await overdueFlag()).toBe(false);
    });

    // The last minute before the company's midnight is still today. This is the case a UTC-based
    // comparison gets wrong in the other direction for a timezone AHEAD of UTC.
    it("holds the boundary at the company's own midnight", async () => {
      vi.setSystemTime(new Date("2026-08-28T22:59:00Z")); // 23:59 in London (BST)
      dueOn("2026-08-28T00:00:00Z");
      expect(await overdueFlag()).toBe(false);
    });
  });

  it("excludes hired kit committed to an active job", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 2 })] as never);
    vi.mocked(gmService.committedByEngineer).mockResolvedValue({ irm: new Map(), rental: new Map([[RENTAL, 2]]), rentalFieldByHire: new Map() } as never);
    expect((await myHoldings(ENG)).find((h) => h.source === "rental")).toBeUndefined();
  });

  it("blocks a field return of job-committed hired kit at create", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 2 })] as never);
    vi.mocked(gmService.committedByEngineer).mockResolvedValue({ irm: new Map(), rental: new Map([[RENTAL, 2]]), rentalFieldByHire: new Map() } as never);
    await expect(
      create({ type: "return", reason: "done with it", priority: "normal", warehouseId: WH, lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1 }] } as never, engineerActor),
    ).rejects.toThrow(/only have 0 .*free to return .*out on a job/i);
  });

  it("names the depot each hire was collected from, and never its id", async () => {
    // Context for the return picker: a hire goes back where it came from, so the row has to say
    // where that is. NAMES only — an id is not a place anyone can drive to.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    const row = (await myHoldings(ENG)).find((h) => h.source === "rental")!;
    expect(row.depots).toEqual(["Leeds"]);
    expect(JSON.stringify(row)).not.toContain(WH);
  });

  it("lists every depot when one item sits on hires from more than one", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_SOON, quantityOnHand: 1 }),
      holding({ purchaseOrderRentalLineId: HIRE_LATER, quantityOnHand: 1 }),
    ] as never);
    vi.mocked(poRepo.findHireDepotsByIds).mockResolvedValue([
      { id: HIRE_SOON, rentalItemId: RENTAL, warehouseId: WH, warehouseName: "Leeds" },
      { id: HIRE_LATER, rentalItemId: RENTAL, warehouseId: OTHER_WH, warehouseName: "Manchester" },
    ] as never);
    const row = (await myHoldings(ENG)).find((h) => h.source === "rental")!;
    expect(row.depots).toEqual(["Leeds", "Manchester"]);
  });

  it("lists only the FIELD-origin depot for a mixed-origin item", async () => {
    // Same item on two hires: FIELD-origin at Manchester, JOB-origin at Leeds. Only Manchester is a
    // counter a Field Stock return can bind, so only Manchester is offered. (Old behaviour listed both,
    // sending the engineer to Leeds where the posting would refuse the scan.)
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_SOON, quantityOnHand: 1 }),
      holding({ purchaseOrderRentalLineId: HIRE_LATER, quantityOnHand: 1 }),
    ] as never);
    vi.mocked(poRepo.findHireDepotsByIds).mockResolvedValue([
      { id: HIRE_SOON, rentalItemId: RENTAL, warehouseId: WH, warehouseName: "Leeds" },
      { id: HIRE_LATER, rentalItemId: RENTAL, warehouseId: OTHER_WH, warehouseName: "Manchester" },
    ] as never);
    vi.mocked(gmService.committedByEngineer).mockResolvedValue({ irm: new Map(), rental: new Map([[RENTAL, 1]]), rentalFieldByHire: new Map([[HIRE_LATER, 1]]) } as never);
    const row = (await myHoldings(ENG)).find((h) => h.source === "rental")!;
    expect(row.depots).toEqual(["Manchester"]);
  });

  it("omits a depot it could not resolve rather than inventing one", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    vi.mocked(poRepo.findHireDepotsByIds).mockResolvedValue([
      { id: HIRE_SOON, rentalItemId: RENTAL, warehouseId: WH, warehouseName: null },
    ] as never);
    const row = (await myHoldings(ENG)).find((h) => h.source === "rental")!;
    expect(row.depots).toEqual([]);
  });

  it("keeps a retired catalogue item returnable", async () => {
    // Kit already in a van has to be able to come home whatever happened to the catalogue behind it.
    vi.mocked(rentalItemRepo.findManyByIds).mockResolvedValue([{ ...RENTAL_ITEM, status: "inactive" }] as never);
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    expect((await myHoldings(ENG)).find((h) => h.source === "rental")).toMatchObject({ code: "RNT-0007", quantityOnHand: 2 });
  });
});

// -- Create-time depot guard: a hire goes back where it came from -------------------------------
//
// The posting guard has always refused a hire from another depot. Nothing said so at CREATE, so the
// request was accepted, routed to a warehouse, staged at the counter, and only died on Post - a
// request no one could ever fulfil. These hold the early refusal AND the fact that it did not come at
// the cost of the two things a return must always still allow: overdue kit, and cancelled orders.

describe("create (return) - the depot a hire goes back to", () => {
  const returnInput = (over: Record<string, unknown> = {}) => ({
    type: "return", reason: "done with it", priority: "normal", warehouseId: WH,
    lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1 }],
    ...over,
  });

  it("accepts a return to the depot the hire actually came from", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    await create(returnInput() as never, engineerActor);
    expect(vsrRepo.createRequest).toHaveBeenCalled();
  });

  it("refuses a return raised against a depot the hire did not come from", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    // The hire lives at OTHER_WH; the engineer is trying to hand it in at WH.
    vi.mocked(poRepo.findHireDepotsByIds).mockResolvedValue([
      { id: HIRE_SOON, rentalItemId: RENTAL, warehouseId: OTHER_WH, warehouseName: "Manchester" },
    ] as never);
    await expect(create(returnInput() as never, engineerActor)).rejects.toThrow(/different depot .*Manchester/i);
    // The whole point: nothing was written, so there is no dead-end request to staff or stage.
    expect(vsrRepo.createRequest).not.toHaveBeenCalled();
  });

  it("still allows an OVERDUE hire back at its own depot", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ hireEndDate: new Date("2020-01-01T00:00:00Z") }),
    ] as never);
    await create(returnInput() as never, engineerActor);
    expect(vsrRepo.createRequest).toHaveBeenCalled();
  });

  it("still allows a hire whose ORDER is cancelled back at its own depot", async () => {
    // The depot read is deliberately not filtered by liveness, so a cancelled order still resolves
    // its warehouse and the kit can come home. Nothing is live here - that is the point.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    vi.mocked(poRepo.findLiveHiresByRentalItems).mockResolvedValue([] as never);
    await create(returnInput() as never, engineerActor);
    expect(vsrRepo.createRequest).toHaveBeenCalled();
  });

  it("counts only the units held at THIS depot, not the engineer's global holding", async () => {
    // Two units of the same item, on two hires, from two depots. One is returnable here, not two.
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_SOON, quantityOnHand: 1 }),
      holding({ purchaseOrderRentalLineId: HIRE_LATER, quantityOnHand: 1 }),
    ] as never);
    vi.mocked(poRepo.findHireDepotsByIds).mockResolvedValue([
      { id: HIRE_SOON, rentalItemId: RENTAL, warehouseId: WH, warehouseName: "Leeds" },
      { id: HIRE_LATER, rentalItemId: RENTAL, warehouseId: OTHER_WH, warehouseName: "Manchester" },
    ] as never);
    await create(returnInput({ lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1 }] }) as never, engineerActor);
    expect(vsrRepo.createRequest).toHaveBeenCalled();
    vi.mocked(vsrRepo.createRequest).mockClear();
    await expect(
      create(returnInput({ lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 2 }] }) as never, engineerActor),
    ).rejects.toThrow(/different depot/i);
    expect(vsrRepo.createRequest).not.toHaveBeenCalled();
  });

  it("never takes the hire from the client - a forged hire id on the line is ignored", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    vi.mocked(poRepo.findHireDepotsByIds).mockResolvedValue([
      { id: HIRE_SOON, rentalItemId: RENTAL, warehouseId: OTHER_WH, warehouseName: "Manchester" },
    ] as never);
    await expect(
      create(
        returnInput({
          lines: [{
            source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1,
            // A crafted body naming a hire at the depot being scanned. It must not be read.
            purchaseOrderRentalLineId: HIRE_LATER, warehouseId: WH,
          }],
        }) as never,
        engineerActor,
      ),
    ).rejects.toThrow(/different depot/i);
    // The depots asked for are the ones off the engineer's OWN custody rows, never the body's.
    expect(vi.mocked(poRepo.findHireDepotsByIds).mock.calls[0][0]).toEqual([HIRE_SOON]);
    expect(vsrRepo.createRequest).not.toHaveBeenCalled();
  });

  it("refuses a return at a depot holding only JOB-origin units, directing it to the field-origin depot", async () => {
    // H_SOON is JOB-origin at WH (Leeds); H_LATER is FIELD-origin at OTHER_WH (Manchester). A return
    // raised at WH must be refused — Leeds's units owe their return to a job — and pointed at Manchester.
    // (Old behaviour: the depot guard counted total custody, so it ACCEPTED the WH return, which the
    // posting could then never bind.)
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_SOON, quantityOnHand: 1 }),
      holding({ purchaseOrderRentalLineId: HIRE_LATER, quantityOnHand: 1 }),
    ] as never);
    vi.mocked(poRepo.findHireDepotsByIds).mockResolvedValue([
      { id: HIRE_SOON, rentalItemId: RENTAL, warehouseId: WH, warehouseName: "Leeds" },
      { id: HIRE_LATER, rentalItemId: RENTAL, warehouseId: OTHER_WH, warehouseName: "Manchester" },
    ] as never);
    // Item-level: 1 unit committed to a job (H_SOON); the field-returnable unit is H_LATER.
    vi.mocked(gmService.committedByEngineer).mockResolvedValue({ irm: new Map(), rental: new Map([[RENTAL, 1]]), rentalFieldByHire: new Map([[HIRE_LATER, 1]]) } as never);
    await expect(
      create({ type: "return", reason: "done", priority: "normal", warehouseId: WH, lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1 }] } as never, engineerActor),
    ).rejects.toThrow(/different depot .*Manchester/i);
    expect(vsrRepo.createRequest).not.toHaveBeenCalled();
  });

  it("leaves an IRM return alone - no depot read, no rental guard", async () => {
    vi.mocked(engineerStockRepo.findEngineerBalances).mockResolvedValueOnce([{ irmItemId: IRM, quantityOnHand: 5 }] as never);
    vi.mocked(irmRepo.findById).mockResolvedValueOnce({ id: IRM, name: "Cable Tie", code: "IRM-1", sku: null, baseUnit: "Each", status: "active", trackSerialNumbers: false, trackBatchNumbers: false } as never);
    await create(
      returnInput({ lines: [{ source: "irm", irmItemId: IRM, itemName: "Cable Tie", qty: 2 }] }) as never,
      engineerActor,
    );
    expect(vsrRepo.createRequest).toHaveBeenCalled();
    expect(poRepo.findHireDepotsByIds).not.toHaveBeenCalled();
  });

  it("does not weaken the posting guard - fulfil still refuses a cross-depot hire", async () => {
    // The create-time check is a courtesy; on-hand moves between composing and scanning, so the
    // in-transaction assertion remains the authority. Same hire, refused at the till.
    vi.mocked(poRepo.findHireStockByIdTx).mockResolvedValue(hire({ warehouseId: OTHER_WH }) as never);
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    await expect(
      runFulfil(
        request({ type: "return", status: "pending", lines: [rentalLine({ requestedQty: 1, approvedQty: 1 })] }),
        { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 1, condition: "good", scannedCode: "RNT-0007" }] },
      ),
    ).rejects.toThrow(/different depot/i);
  });
});

// -- A retired catalogue entry does not strand the kit already out ------------------------------

describe("retired catalogue item - returnable, never requestable", () => {
  const retired = { ...RENTAL_ITEM, status: "inactive" };

  it("lets a return be RAISED for a retired item", async () => {
    vi.mocked(rentalItemRepo.findById).mockResolvedValue(retired as never);
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    await create(
      { type: "return", reason: "done with it", priority: "normal", warehouseId: WH, lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1 }] } as never,
      engineerActor,
    );
    expect(vsrRepo.createRequest).toHaveBeenCalled();
  });

  it("lets the warehouse SCAN a retired item in on a return", async () => {
    vi.mocked(rentalItemRepo.findByCodeAnyStatus).mockResolvedValue(retired as never);
    vi.mocked(rentalItemRepo.findActiveByCode).mockResolvedValue(null as never);
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    vi.mocked(vsrRepo.findById).mockResolvedValue(
      request({ type: "return", status: "pending", lines: [rentalLine({ requestedQty: 1, approvedQty: 1 })] }) as never,
    );
    const res = await scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin);
    expect(res).toMatchObject({ source: "rental", rentalItemId: RENTAL });
    expect(res.hires[0]).toMatchObject({ purchaseOrderRentalLineId: HIRE_SOON });
  });

  it("still refuses to REQUEST a retired item - retiring stops it being issued", async () => {
    vi.mocked(rentalItemRepo.findById).mockResolvedValue(retired as never);
    await expect(
      create({ type: "restock", reason: "x", priority: "normal", lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1, warehouseId: WH }] } as never, engineerActor),
    ).rejects.toThrow(/is not active/i);
  });

  it("still refuses a retired item at the RESTOCK scan", async () => {
    vi.mocked(rentalItemRepo.findActiveByCode).mockResolvedValue(null as never);
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ status: "approved" }) as never);
    await expect(scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin)).rejects.toThrow(/No active catalogue item/i);
  });
});

// ── 17, 20. Scan lookup, replay and access ───────────────────────────────────────────────────────

describe("scanLookup — resolving a hire label", () => {
  it("resolves a rental code and previews the hire it would bind", async () => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(request() as never);
    const out = await scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin);
    expect(out).toMatchObject({ source: "rental", rentalItemId: RENTAL, lineId: LINE_ID, remainingQty: 2, available: 3 });
    expect(out.hires[0]).toMatchObject({ purchaseOrderRentalLineId: HIRE_SOON, poCode: "PO-0042", qty: 2 });
  });

  // 17. Replay protection: the canonical line math says a fully-fulfilled line has nothing left.
  it("refuses a line that is already fully fulfilled", async () => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ lines: [rentalLine({ fulfilledQty: 2 })] }) as never);
    await expect(scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin)).rejects.toThrow(/already fully fulfilled/i);
  });

  it("refuses an item that isn't on the request", async () => {
    vi.mocked(rentalItemRepo.findActiveByCode).mockResolvedValue({ ...RENTAL_ITEM, id: RENTAL_2, code: "RNT-0099" } as never);
    vi.mocked(vsrRepo.findById).mockResolvedValue(request() as never);
    await expect(scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0099" } as never, admin)).rejects.toThrow(/isn't on this request/i);
  });

  // 20. A line is only ever handled from the warehouse it belongs to — enforced even for an admin.
  it("refuses a scan from the wrong warehouse tab", async () => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ lines: [rentalLine({ sourceWarehouseId: OTHER_WH, sourceWarehouseName: "York" })], warehouseId: OTHER_WH, preferredWarehouseId: OTHER_WH }) as never);
    await expect(scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin)).rejects.toThrow(/scan it from that warehouse/i);
  });

  it("refuses a warehouse-scoped reviewer acting outside their scope", async () => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(request() as never);
    const scoped = { id: "u2", email: "york@x.com", type: "user", permissions: ["van_stock_request.review"], assignedWarehouseIds: [OTHER_WH] } as never;
    await expect(scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, scoped)).rejects.toThrow(/access/i);
  });

  it("falls back to rental only after IRM misses, so one label never means two things", async () => {
    vi.mocked(irmService.findActiveByCodeOrBarcode).mockResolvedValue({ id: IRM, name: "CAT6", code: "RNT-0007", baseUnit: "m", trackSerialNumbers: false, trackBatchNumbers: false } as never);
    vi.mocked(vsrRepo.findById).mockResolvedValue(request({ lines: [rentalLine({ source: "irm", irmItemId: IRM, rentalItemId: null, itemName: "CAT6" })] }) as never);
    vi.mocked(inventoryRepo.findBalancePair).mockResolvedValue({ quantityOnHand: 9 } as never);
    const out = await scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin);
    expect(out.source).toBe("irm");
    expect(rentalItemRepo.findActiveByCode).not.toHaveBeenCalled();
  });
});

// ── 13, 21. Walk-in and legacy rows ──────────────────────────────────────────────────────────────

// ── Expensive reads happen ONCE per logical request ──────────────────────────────────────────────
//
// These are query-count assertions, not micro-benchmarks. Each one guards a read that was genuinely
// duplicated: getOpenDemand walks every active job and every movement on it, committedByEngineer
// walks the same two sets, and the hire finder was being asked per scanned entry on a posting the
// reviewer can take to a hundred lines. Counting the calls is the only way these stay fixed — none of
// them changes a returned number, so nothing else in the suite would notice a regression.

describe("one expensive read per request", () => {
  it("resolves open job demand ONCE for a composer keystroke, not once per pool", async () => {
    vi.mocked(rentalItemRepo.findMany).mockResolvedValue({ items: [RENTAL_ITEM], total: 1 } as never);
    await searchRequestableItems("tester");
    // Both pools net against the same figure. Resolved separately they walked the jobs twice, and
    // sequentially — the rental options were awaited before the IRM demand was even requested.
    expect(gmService.getOpenDemand).toHaveBeenCalledTimes(1);
  });

  it("resolves open job demand ONCE for an availability call covering both pools", async () => {
    await availability([IRM], [RENTAL]);
    expect(gmService.getOpenDemand).toHaveBeenCalledTimes(1);
  });

  it("reads the engineer's jobs and movements ONCE for both committed pools", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding()] as never);
    await myHoldings(ENG);
    // The IRM and rental committed maps are two different answers off ONE snapshot. Two calls here
    // means the pair of single-pool readers came back.
    expect(gmService.committedByEngineer).toHaveBeenCalledTimes(1);
  });

  it("looks up hires ONCE per fulfilment, not once per scanned entry", async () => {
    // Three entries against the same line and depot. The lookup used to sit inside the loop, so this
    // was three round trips asking the same question.
    const req = request({ type: "return", status: "pending", lines: [rentalLine({ requestedQty: 3, approvedQty: 3 })] });
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 3 })] as never);
    vi.mocked(rentalCustodyRepo.upsertRentalHoldingTx).mockResolvedValue({ quantityOnHand: 0 } as never);
    await runFulfil(req, {
      warehouseId: WH,
      entries: [
        { lineId: LINE_ID, qty: 1, condition: "good", scannedCode: "RNT-0007" },
        { lineId: LINE_ID, qty: 1, condition: "good", scannedCode: "RNT-0007" },
        { lineId: LINE_ID, qty: 1, condition: "good", scannedCode: "RNT-0007" },
      ],
    });
    expect(poRepo.findLiveHiresByRentalItems).toHaveBeenCalledTimes(1);
  });

  // Batching must not have flattened the two legs into one question. An issue may never bind an
  // expired hire; a return must be able to.
  it("still asks the ISSUABLE finder on a restock and the LIVE finder on a return", async () => {
    await runFulfil(request(), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] });
    expect(poRepo.findIssuableHiresByRentalItems).toHaveBeenCalledTimes(1);
    expect(poRepo.findLiveHiresByRentalItems).not.toHaveBeenCalled();
  });
});

// -- Walk-in: hired kit over the counter ---------------------------------------------------------
//
// A walk-in opens ALREADY-APPROVED, so it never passes through approve() - which is the gate an
// engineer-raised rental line meets the free-on-hire hard block at. These hold the replacement gate at
// create, and that lifting the front-door refusal did not loosen anything behind it.

describe("walk-in - issuing hired kit at the counter", () => {
  const walkInInput = (over: Record<string, unknown> = {}) => ({
    engineerId: ENG, warehouseId: WH, reason: "counter issue", priority: "normal",
    lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1 }],
    ...over,
  });

  beforeEach(() => {
    // Free-on-hire at this depot comes from the ISSUABLE finder, same as approve() and the scan panel.
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire({ quantity: 3, receivedQuantity: 3 })] as never);
  });

  it("creates a pre-approved rental line, bound to the catalogue item and this counter", async () => {
    await walkIn(walkInInput() as never, admin);
    const [data, lines] = vi.mocked(vsrRepo.createRequest).mock.calls[0]!;
    expect(data).toMatchObject({ createdVia: "walk_in", status: "approved", warehouseId: WH });
    expect(lines[0]).toMatchObject({ source: "rental", rentalItemId: RENTAL, requestedQty: 1, approvedQty: 1, sourceWarehouseId: WH });
    // No hire is named at create - which one supplies the units is the posting's decision.
    expect(lines[0]).not.toHaveProperty("purchaseOrderRentalLineId");
  });

  it("refuses more than is free on hire at this depot", async () => {
    await expect(walkIn(walkInInput({ lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 9 }] }) as never, admin))
      .rejects.toThrow(/only 3 free on hire/i);
    expect(vsrRepo.createRequest).not.toHaveBeenCalled();
  });

  // The scenario the spec calls out: 5 on hire, 2 planned for jobs, 4 asked for at the counter.
  it("subtracts open job demand before deciding - 5 on hire, 2 planned, 4 asked = refused", async () => {
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire({ quantity: 5, receivedQuantity: 5 })] as never);
    vi.mocked(gmService.getOpenDemand).mockResolvedValue(
      new Map([["k", { rentalItemId: RENTAL, irmItemId: null, warehouseId: WH, demand: 2 }]]) as never,
    );
    await expect(walkIn(walkInInput({ lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 4 }] }) as never, admin))
      .rejects.toThrow(/only 3 free on hire/i);
    // 3 is exactly what is left, and it must still be issuable.
    vi.mocked(vsrRepo.createRequest).mockClear();
    await walkIn(walkInInput({ lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 3 }] }) as never, admin);
    expect(vsrRepo.createRequest).toHaveBeenCalled();
  });

  it("refuses when the period has ended - an expired hire is not free on hire", async () => {
    // The ISSUABLE finder is what excludes an expired hire; an empty result is what the counter sees.
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([] as never);
    await expect(walkIn(walkInInput() as never, admin)).rejects.toThrow(/no hired unit is free/i);
    expect(vsrRepo.createRequest).not.toHaveBeenCalled();
  });

  it("asks the ISSUABLE finder against COMPANY today, not the process clock", async () => {
    await walkIn(walkInInput() as never, admin);
    expect(poRepo.findIssuableHiresByRentalItems).toHaveBeenCalled();
    const [, todayStart, whIds] = vi.mocked(poRepo.findIssuableHiresByRentalItems).mock.calls[0]!;
    expect(todayStart).toBeInstanceOf(Date);
    // Depot-scoped: another depot's hires are a different physical shelf.
    expect(whIds).toEqual([WH]);
  });

  it("refuses a retired catalogue item - a walk-in ASKS for kit", async () => {
    vi.mocked(rentalItemRepo.findById).mockResolvedValue({ ...RENTAL_ITEM, status: "inactive" } as never);
    await expect(walkIn(walkInInput() as never, admin)).rejects.toThrow(/is not active/i);
  });

  it("never reads a hire id from the request body", async () => {
    await walkIn(
      walkInInput({ lines: [{ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty: 1, purchaseOrderRentalLineId: HIRE_LATER }] }) as never,
      admin,
    );
    const [, lines] = vi.mocked(vsrRepo.createRequest).mock.calls[0]!;
    expect(JSON.stringify(lines)).not.toContain(HIRE_LATER);
  });

  it("still refuses a non-stock-holding or inactive engineer, unchanged", async () => {
    vi.mocked(userRepo.findById).mockResolvedValue({ id: ENG, firstName: "X", lastName: "Y", email: "x@y.com", status: "inactive", role: { canHoldStock: true } } as never);
    await expect(walkIn(walkInInput() as never, admin)).rejects.toThrow(/not active/i);
  });

  it("leaves the COMPANY-STOCK walk-in path untouched", async () => {
    vi.mocked(irmRepo.findById).mockResolvedValue({ id: IRM, name: "Cable Tie", code: "IRM-1", sku: null, baseUnit: "Each", status: "active", trackSerialNumbers: false, trackBatchNumbers: false } as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([{ irmItemId: IRM, warehouseId: WH, quantityOnHand: 4 }] as never);
    await walkIn(walkInInput({ lines: [{ source: "irm", irmItemId: IRM, itemName: "Cable Tie", qty: 2 }] }) as never, admin);
    const [, lines] = vi.mocked(vsrRepo.createRequest).mock.calls[0]!;
    expect(lines[0]).toMatchObject({ source: "irm", irmItemId: IRM, requestedQty: 2 });
    // No hire lookup on a company-stock walk-in.
    expect(poRepo.findIssuableHiresByRentalItems).not.toHaveBeenCalled();
  });

  it("refuses a company-stock line the shelf cannot cover, unchanged", async () => {
    vi.mocked(irmRepo.findById).mockResolvedValue({ id: IRM, name: "Cable Tie", code: "IRM-1", sku: null, baseUnit: "Each", status: "active", trackSerialNumbers: false, trackBatchNumbers: false } as never);
    vi.mocked(inventoryRepo.findBalancesByItemsAndWarehouses).mockResolvedValue([{ irmItemId: IRM, warehouseId: WH, quantityOnHand: 1 }] as never);
    await expect(walkIn(walkInInput({ lines: [{ source: "irm", irmItemId: IRM, itemName: "Cable Tie", qty: 5 }] }) as never, admin))
      .rejects.toThrow(/only 1 in stock/i);
  });
});

describe("walk-in search - the counter sees both pools", () => {
  beforeEach(() => {
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire({ quantity: 2, receivedQuantity: 2 })] as never);
    vi.mocked(rentalItemRepo.findMany).mockResolvedValue({ items: [RENTAL_ITEM], total: 1 } as never);
    vi.mocked(irmRepo.findMany).mockResolvedValue([] as never);
  });

  it("returns hired kit alongside company stock, flagged as rental", async () => {
    const out = await searchWarehouseItems(admin, WH, "tester");
    const rental = out.find((o) => o.source === "rental");
    expect(rental).toMatchObject({ rentalItemId: RENTAL, code: "RNT-0007", quantityOnHand: 2 });
    expect(rental!.irmItemId).toBeNull();
  });

  it("carries the deadline and the order code for the counter to read", async () => {
    const rental = (await searchWarehouseItems(admin, WH, "tester")).find((o) => o.source === "rental")!;
    expect(rental.hireEndDate).toBe(new Date("2026-12-01T00:00:00Z").toISOString());
    expect(rental.poCodes).toEqual(["PO-0042"]);
  });

  it("drops a hire with nothing free at THIS depot", async () => {
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([] as never);
    expect((await searchWarehouseItems(admin, WH, "tester")).find((o) => o.source === "rental")).toBeUndefined();
  });

  it("nets the counter's view against open job demand, like every other door on this shelf", async () => {
    vi.mocked(gmService.getOpenDemand).mockResolvedValue(
      new Map([["k", { rentalItemId: RENTAL, irmItemId: null, warehouseId: WH, demand: 2 }]]) as never,
    );
    expect((await searchWarehouseItems(admin, WH, "tester")).find((o) => o.source === "rental")).toBeUndefined();
  });

  it("scopes the hire lookup to the counter's own warehouse", async () => {
    await searchWarehouseItems(admin, WH, "tester");
    const [, , whIds] = vi.mocked(poRepo.findIssuableHiresByRentalItems).mock.calls[0]!;
    expect(whIds).toEqual([WH]);
  });
});

describe("boundaries", () => {
  // Hired kit at the counter WAS refused outright, deferred pending a business decision that has now
  // been made. What replaced the refusal is the gate below, not nothing: a walk-in still skips
  // approve(), so the free-on-hire check it would have met has to run at create instead. This asserts
  // the boundary that remains — the counter cannot pre-approve a hire this depot cannot supply.
  it("no longer refuses hired kit outright, but still refuses what it cannot supply", async () => {
    vi.mocked(poRepo.findIssuableHiresByRentalItems).mockResolvedValue([hire({ quantity: 1, receivedQuantity: 1 })] as never);
    const line = (qty: number) => ({ source: "rental", rentalItemId: RENTAL, itemName: "Fibre Tester", qty });
    const at = (qty: number) => ({ engineerId: ENG, warehouseId: WH, reason: "counter", priority: "normal", lines: [line(qty)] });
    await expect(walkIn(at(1) as never, admin)).resolves.toBeTruthy();
    await expect(walkIn(at(2) as never, admin)).rejects.toThrow(/only 1 free on hire/i);
  });

  // 21. Every row written before this shipped is an IRM row with no `source` column at all.
  it("reads a legacy IRM-only line unchanged", async () => {
    const legacy = request({
      lines: [{ ...rentalLine({ source: "irm", irmItemId: IRM, rentalItemId: null, itemName: "CAT6", code: "IRM-0002" }) }],
    });
    vi.mocked(vsrRepo.findById).mockResolvedValue(legacy as never);
    vi.mocked(irmService.findActiveByCodeOrBarcode).mockResolvedValue({ id: IRM, name: "CAT6", code: "IRM-0002", baseUnit: "m", trackSerialNumbers: false, trackBatchNumbers: false } as never);
    vi.mocked(inventoryRepo.findBalancePair).mockResolvedValue({ quantityOnHand: 4 } as never);
    const out = await scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "IRM-0002" } as never, admin);
    expect(out).toMatchObject({ source: "irm", irmItemId: IRM, rentalItemId: null, available: 4 });
    expect(out.hires).toEqual([]);
  });
});

// ── The ORIGIN INVARIANT, re-asserted at POSTING TIME ───────────────────────────────────────────
//
// Create-time availability and the engineer's picker both offer only FIELD-door custody. Neither is
// binding: they are read outside the posting transaction, they hold no reservation, and the only
// quantity guard inside the transaction is `upsertRentalHoldingTx`'s floor on TOTAL custody. Total
// custody is job-origin PLUS field-origin, so a posting that arrives after the field-origin units have
// gone can satisfy that floor by draining JOB-origin units instead — writing a `van_return` against
// kit that owes its return to a job. The units leave the wrong door, the job's outstanding count is
// silently unbackable, and nothing in the ledger says the conversion happened.
//
// Reachable without any exotic timing: the create guard is advisory and reserves nothing, so two
// return requests for the same hire can both be raised while the field-origin figure still covers
// each of them, and the second posting is the one that overdraws. So the transaction re-reads the
// field-door net itself — the same `van_restock − van_return` derivation, from the same ledger, inside
// the transaction that does the draining.

describe("fulfil (return) — the origin invariant at posting time", () => {
  // §4's scenario, in the numbers it specifies: job-origin 2 + field-origin 3 = custody 5, and a
  // return for 3 already raised against it. Then a legitimate concurrent Field Stock return posts
  // first and takes 2 of the field-origin units, leaving 1.
  const returnFor = (qty: number) =>
    request({ type: "return", status: "pending", lines: [rentalLine({ requestedQty: qty, approvedQty: qty })] });
  const entryFor = (qty: number) => ({ lineId: LINE_ID, qty, condition: "good", scannedCode: "RNT-0007" });

  beforeEach(() => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([holding({ quantityOnHand: 5 })] as never);
    vi.mocked(rentalCustodyRepo.findRentalHoldingTx).mockResolvedValue(holding({ quantityOnHand: 5 }) as never);
    vi.mocked(rentalCustodyRepo.upsertRentalHoldingTx).mockResolvedValue({ quantityOnHand: 2 } as never);
  });

  it("refuses the posting when the field-origin units are no longer there, though total custody would cover it", async () => {
    // Custody 5 still covers a return of 3 — the floor guard would wave it through — but only 1 unit
    // of field-door custody is left. The other 2 would have to come out of the job's units.
    fieldOriginTx({ [HIRE_SOON]: 1 });
    await expect(
      runFulfil(returnFor(3), { warehouseId: WH, entries: [entryFor(3)] }),
    ).rejects.toThrow(/only 1 .*collected through Field Stock/i);
  });

  it("moves NOTHING when it refuses", async () => {
    // The whole point of doing this inside the transaction. No custody drain, no van_return row, no
    // release of the hire's issued counter, no custody exit — so the job-origin quantity after the
    // attempt is exactly what it was before.
    fieldOriginTx({ [HIRE_SOON]: 1 });
    await expect(runFulfil(returnFor(3), { warehouseId: WH, entries: [entryFor(3)] })).rejects.toThrow();
    expect(rentalCustodyRepo.upsertRentalHoldingTx).not.toHaveBeenCalled();
    expect(rentalCustodyRepo.insertRentalTxnTx).not.toHaveBeenCalled();
    expect(poRepo.adjustHireIssuedQtyTx).not.toHaveBeenCalled();
    expect(custodyExitRepo.createExitTx).not.toHaveBeenCalled();
  });

  it("refuses outright when every field-origin unit has gone, rather than falling back to job-origin", async () => {
    fieldOriginTx({ [HIRE_SOON]: 0 });
    await expect(
      runFulfil(returnFor(2), { warehouseId: WH, entries: [entryFor(2)] }),
    ).rejects.toThrow(/only 0 .*collected through Field Stock/i);
    expect(rentalCustodyRepo.upsertRentalHoldingTx).not.toHaveBeenCalled();
  });

  it("refuses a hire with no field-door history at all", async () => {
    // Absent from the map, not zero in it — a hire the engineer only ever received through a job.
    fieldOriginTx({});
    await expect(runFulfil(returnFor(1), { warehouseId: WH, entries: [entryFor(1)] })).rejects.toThrow(/Field Stock/i);
    expect(rentalCustodyRepo.insertRentalTxnTx).not.toHaveBeenCalled();
  });

  it("posts normally when the field-origin units really are still there", async () => {
    // The positive control: 3 field-origin of 5 held, returning exactly 3.
    fieldOriginTx({ [HIRE_SOON]: 3 });
    const posted = await runFulfil(returnFor(3), { warehouseId: WH, entries: [entryFor(3)] });
    expect(posted[0]).toMatchObject({ source: "rental", purchaseOrderRentalLineId: HIRE_SOON, qty: 3 });
    expect(rentalCustodyRepo.upsertRentalHoldingTx).toHaveBeenCalledWith(expect.anything(), HIRE_SOON, ENG, -3, expect.anything());
    expect(rentalCustodyRepo.insertRentalTxnTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: "van_return", quantityDelta: -3 }));
  });

  it("spends the field-origin budget ONCE across every entry in the same posting", async () => {
    // Two scanned entries against the same hire. 3 field-origin covers the first two units and one of
    // the second pair; the posting must fail rather than let the fourth unit come off the job's stock.
    fieldOriginTx({ [HIRE_SOON]: 3 });
    await expect(
      runFulfil(returnFor(4), { warehouseId: WH, entries: [entryFor(2), entryFor(2)] }),
    ).rejects.toThrow(/only 1 .*collected through Field Stock/i);
  });

  it("reads the field-door net once per posting, not once per entry", async () => {
    fieldOriginTx({ [HIRE_SOON]: 4 });
    await runFulfil(returnFor(4), { warehouseId: WH, entries: [entryFor(2), entryFor(2)] });
    expect(rentalCustodyRepo.findFieldOriginByHiresTx).toHaveBeenCalledTimes(1);
    expect(rentalCustodyRepo.findFieldOriginByHiresTx).toHaveBeenCalledWith(expect.anything(), ENG, [HIRE_SOON]);
  });

  it("does not ask the ledger at all on the RESTOCK leg", async () => {
    // Collecting kit creates field-origin; it cannot consume it. The guard belongs to the return leg
    // only, and paying for the read on an issue would be pure waste.
    vi.mocked(rentalCustodyRepo.upsertRentalHoldingTx).mockResolvedValue({ quantityOnHand: 2 } as never);
    await runFulfil(request({ type: "restock", status: "approved" }), { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 2, condition: "good", scannedCode: "RNT-0007" }] });
    expect(rentalCustodyRepo.findFieldOriginByHiresTx).not.toHaveBeenCalled();
  });

  it("leaves an IRM return alone — company stock has no hire to have an origin on", async () => {
    vi.mocked(engineerStockRepo.upsertEngineerBalanceTx).mockResolvedValue({ quantityOnHand: 0 } as never);
    const irmReq = request({ type: "return", status: "pending", lines: [rentalLine({ source: "irm", irmItemId: IRM, rentalItemId: null, itemName: "CAT6", requestedQty: 1, approvedQty: 1 })] });
    await runFulfil(irmReq, { warehouseId: WH, entries: [{ lineId: LINE_ID, qty: 1, condition: "good" }] });
    expect(rentalCustodyRepo.findFieldOriginByHiresTx).not.toHaveBeenCalled();
  });
});

// ── The RETURN SCAN PANEL is origin-aware, exactly as the posting allocator is ───────────────────
//
// The panel STAGES what the reviewer then posts. Its candidates used to come from raw custody, so with
// a job-origin hire due sooner than a field-origin one it presented the JOB's hire — wrong PO code,
// wrong deadline, and an `available` figure counting units Field Stock may never take back. The
// posting re-derives the hire server-side (the client never sends one), so nothing was mis-bound; the
// counter was simply told the wrong thing about the return it was making.
describe("scanLookup (return) — the panel shows the FIELD-origin hire", () => {
  const returnReq = (over: Record<string, unknown> = {}) =>
    request({ type: "return", status: "pending", lines: [rentalLine({ requestedQty: 2, approvedQty: 2 })], ...over });

  beforeEach(() => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(returnReq() as never);
    // Both hires are live at this depot, so depot eligibility is not what these tests turn on.
    vi.mocked(poRepo.findLiveHiresByRentalItems).mockResolvedValue([hire(), hire({ id: HIRE_LATER })] as never);
  });

  // 1 + 6. The reported shape: job-origin due sooner, field-origin due later.
  it("skips a job-origin hire that is due sooner and presents the field-origin one", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_SOON, poCode: "PO-JOB", quantityOnHand: 2, hireEndDate: new Date("2026-09-01T00:00:00Z") }),
      holding({ purchaseOrderRentalLineId: HIRE_LATER, poCode: "PO-FIELD", quantityOnHand: 3, hireEndDate: new Date("2026-12-01T00:00:00Z") }),
    ] as never);
    fieldOrigin({ [HIRE_LATER]: 3 }); // HIRE_SOON is job-origin only

    const out = await scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin);
    // `available` is the FIELD-origin total, not 5.
    expect(out.available).toBe(3);
    expect(out.hires).toEqual([expect.objectContaining({ purchaseOrderRentalLineId: HIRE_LATER, poCode: "PO-FIELD", qty: 2 })]);
    // The PO code and deadline on the row belong to the hire the posting will actually credit.
    expect(out.hires[0]!.hireEndDate).toBe(new Date("2026-12-01T00:00:00Z").toISOString());
  });

  // 3. Mixed origin on ONE hire: only the field-door share is offered.
  it("offers only the field-door share when one hire carries both origins", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_SOON, quantityOnHand: 5 }),
    ] as never);
    fieldOrigin({ [HIRE_SOON]: 3 }); // 2 of the 5 came in on a job

    const out = await scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin);
    expect(out.available).toBe(3);
    expect(out.hires).toEqual([expect.objectContaining({ purchaseOrderRentalLineId: HIRE_SOON, qty: 2 })]);
  });

  // 4. Several field-origin hires: existing soonest-first order and splitting are preserved.
  it("keeps soonest-first ordering and splitting across field-origin hires", async () => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(returnReq({ lines: [rentalLine({ requestedQty: 3, approvedQty: 3 })] }) as never);
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_LATER, poCode: "PO-LATE", quantityOnHand: 5, hireEndDate: new Date("2026-12-01T00:00:00Z") }),
      holding({ purchaseOrderRentalLineId: HIRE_SOON, poCode: "PO-EARLY", quantityOnHand: 5, hireEndDate: new Date("2026-09-01T00:00:00Z") }),
    ] as never);
    fieldOrigin({ [HIRE_SOON]: 2, [HIRE_LATER]: 4 });

    const out = await scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin);
    expect(out.available).toBe(6);
    // Soonest deadline first, capped at ITS field-origin, remainder onto the next.
    expect(out.hires.map((h) => [h.poCode, h.qty])).toEqual([["PO-EARLY", 2], ["PO-LATE", 1]]);
  });

  // 5. Job-origin-only custody is not a Field Stock candidate at all, and says so truthfully.
  it("refuses a job-origin-only holding instead of presenting it", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_SOON, quantityOnHand: 2 }),
    ] as never);
    fieldOrigin({}); // no field-door history at all

    await expect(scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin))
      .rejects.toThrow(/collected through Field Stock/i);
  });

  // 9. One ledger read for the whole scan, keyed on the hires actually held.
  it("asks the ledger once, for the hires the engineer holds", async () => {
    vi.mocked(rentalCustodyRepo.findRentalHoldingsByEngineer).mockResolvedValue([
      holding({ purchaseOrderRentalLineId: HIRE_SOON, quantityOnHand: 2 }),
    ] as never);
    fieldOrigin({ [HIRE_SOON]: 2 });

    await scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin);
    expect(rentalCustodyRepo.findFieldOriginByHires).toHaveBeenCalledTimes(1);
    expect(rentalCustodyRepo.findFieldOriginByHires).toHaveBeenCalledWith(ENG, [HIRE_SOON]);
  });

  // The ISSUE leg reads the depot's hires, not custody — untouched.
  it("leaves the RESTOCK leg's hire preview alone", async () => {
    vi.mocked(vsrRepo.findById).mockResolvedValue(request() as never);
    const out = await scanLookup({ requestId: REQ_ID, warehouseId: WH, code: "RNT-0007" } as never, admin);
    expect(out).toMatchObject({ source: "rental", available: 3 });
    expect(out.hires[0]).toMatchObject({ purchaseOrderRentalLineId: HIRE_SOON, poCode: "PO-0042", qty: 2 });
  });
});
