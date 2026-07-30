import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused on receiveStockAssignment's "which stock line do the received units land on?"
// decision (the top-up behaviour): mock the repository + audit so the branches can be
// asserted in isolation. assertWarehouseAccess is pure and passes for an undefined actor.
vi.mock("./customer.repository.js", () => ({
  findAssignmentById: vi.fn(),
  updateAssignmentReceived: vi.fn(),
  findAssignmentsByRequest: vi.fn(),
  updateStockRequestStatus: vi.fn(),
  touchStockRequest: vi.fn(),
  findStockEntriesByAssignment: vi.fn(),
  findStockEntryById: vi.fn(),
  findStockEntryForTopUp: vi.fn(),
  addStockEntryQuantity: vi.fn(),
  createStockEntry: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
// The receive runs its writes inside a transaction; run the callback synchronously with a stub
// tx client (the repo is mocked, so the client is only threaded through as the last call arg).
// Both wrappers are stubbed the same way — the retry only fires on a real Mongo write-conflict,
// which a mocked repository can never raise.
const TX = {};
vi.mock("../../lib/prisma.js", () => ({
  prisma: {},
  withTransaction: (fn: (tx: unknown) => unknown) => fn(TX),
  withTransactionRetry: (fn: (tx: unknown) => unknown) => fn(TX),
}));

import * as customerRepo from "./customer.repository.js";
import { receiveStockAssignment } from "./customer.service.js";

const ASSIGN_ID = "a".repeat(24);
const CUST_ID = "c".repeat(24);
const REQ_ID = "f".repeat(24);
const WH_ID = "b".repeat(24);
const OTHER_WH_ID = "9".repeat(24); // a DIFFERENT warehouse than the assignment delivers to
const LINKED_ID = "d".repeat(24);

const repo = vi.mocked(customerRepo);

function assignmentRow(over: { linkedStockEntryId?: string | null; editedName?: string | null } = {}) {
  return {
    id: ASSIGN_ID,
    warehouseId: WH_ID,
    customerStockRequestId: REQ_ID,
    quantity: 10,
    receivedQuantity: 0,
    status: "pending",
    warehouse: { id: WH_ID, name: "London Logistics Hub", code: "WH-0005" },
    stockRequest: {
      id: REQ_ID,
      customerId: CUST_ID,
      name: "SC/APC Connectors",
      editedName: over.editedName ?? null,
      quantity: 10,
      status: "assigned",
      linkedStockEntryId: over.linkedStockEntryId ?? null,
    },
  } as unknown as Awaited<ReturnType<typeof customerRepo.findAssignmentById>>;
}

function linkedEntry(over: { warehouseId?: string } = {}) {
  return {
    id: LINKED_ID,
    customerId: CUST_ID,
    // Default: the linked line lives in a DIFFERENT warehouse than this assignment delivers to, so
    // resolution must go through findStockEntryForTopUp. Pass WH_ID to exercise the same-warehouse
    // direct-top-up path.
    warehouseId: over.warehouseId ?? OTHER_WH_ID,
    itemName: "SC/APC Connectors",
    sku: "SKU-1",
    categoryId: "e".repeat(24),
    description: "desc",
    uom: "Each",
    serialized: false,
    highValue: true,
    thresholdQty: 5,
  } as unknown as Awaited<ReturnType<typeof customerRepo.findStockEntryById>>;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The atomic receive succeeds (won the optimistic race) and reports the assignment fully received.
  repo.updateAssignmentReceived.mockResolvedValue({
    id: ASSIGN_ID,
    warehouseId: WH_ID,
    quantity: 10,
    receivedQuantity: 10,
    status: "received",
    receivedBy: null,
    receivedAt: new Date("2026-06-23T00:00:00Z"),
    notes: null,
    warehouse: { id: WH_ID, name: "London Logistics Hub", code: "WH-0005" },
  } as never);
  repo.findAssignmentsByRequest.mockResolvedValue([{ status: "received" }] as never);
  repo.updateStockRequestStatus.mockResolvedValue({} as never);
  repo.findStockEntriesByAssignment.mockResolvedValue([] as never);
  repo.addStockEntryQuantity.mockResolvedValue({ id: "topUpEntry" } as never);
  repo.createStockEntry.mockResolvedValue({ id: "newEntry" } as never);
});

describe("receiveStockAssignment — stock-line resolution", () => {
  it("creates a fresh entry for an UNLINKED submission (new product)", async () => {
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ editedName: "SC/APC Connectors v2" }));

    const res = await receiveStockAssignment(ASSIGN_ID, { receivedQuantity: 10 });

    expect(repo.createStockEntry).toHaveBeenCalledTimes(1);
    expect(repo.createStockEntry).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: CUST_ID, warehouseId: WH_ID, assignmentId: ASSIGN_ID, itemName: "SC/APC Connectors v2", quantity: 10 }),
      TX,
    );
    expect(repo.findStockEntryForTopUp).not.toHaveBeenCalled();
    expect(repo.addStockEntryQuantity).not.toHaveBeenCalled();
    expect(res.stockEntryId).toBe("newEntry");
  });

  it("tops up the matching line when a LINKED submission lands in a warehouse that holds the product", async () => {
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ linkedStockEntryId: LINKED_ID }));
    repo.findStockEntryById.mockResolvedValue(linkedEntry());
    repo.findStockEntryForTopUp.mockResolvedValue({ id: "existingLine" });

    const res = await receiveStockAssignment(ASSIGN_ID, { receivedQuantity: 10 });

    expect(repo.findStockEntryForTopUp).toHaveBeenCalledWith(CUST_ID, WH_ID, "SC/APC Connectors", "SKU-1", TX);
    expect(repo.addStockEntryQuantity).toHaveBeenCalledWith("existingLine", 10, null, expect.any(Date), TX);
    expect(repo.createStockEntry).not.toHaveBeenCalled();
    expect(res.stockEntryId).toBe("topUpEntry");
  });

  it("tops up the LINKED line DIRECTLY when it already lives in the receiving warehouse (never re-matches by name/sku)", async () => {
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ linkedStockEntryId: LINKED_ID }));
    repo.findStockEntryById.mockResolvedValue(linkedEntry({ warehouseId: WH_ID })); // linked line is in THIS warehouse
    // Guard against the regression: even if a same-named sibling line would be returned by the
    // name/sku matcher, the explicitly-linked entry must win — the matcher is never consulted.
    repo.findStockEntryForTopUp.mockResolvedValue({ id: "wrongSiblingLine" });

    const res = await receiveStockAssignment(ASSIGN_ID, { receivedQuantity: 10 });

    expect(repo.addStockEntryQuantity).toHaveBeenCalledWith(LINKED_ID, 10, null, expect.any(Date), TX);
    expect(repo.findStockEntryForTopUp).not.toHaveBeenCalled();
    expect(repo.createStockEntry).not.toHaveBeenCalled();
    expect(res.stockEntryId).toBe("topUpEntry");
  });

  it("opens a fresh line COPYING the linked product details when the warehouse doesn't hold it yet", async () => {
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ linkedStockEntryId: LINKED_ID }));
    repo.findStockEntryById.mockResolvedValue(linkedEntry());
    repo.findStockEntryForTopUp.mockResolvedValue(null);

    await receiveStockAssignment(ASSIGN_ID, { receivedQuantity: 10 });

    expect(repo.addStockEntryQuantity).not.toHaveBeenCalled();
    expect(repo.createStockEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        warehouseId: WH_ID,
        itemName: "SC/APC Connectors",
        sku: "SKU-1",
        categoryId: "e".repeat(24),
        uom: "Each",
        highValue: true,
        thresholdQty: 5,
      }),
      TX,
    );
  });

  it("accumulates into the assignment's own entry on a partial RE-receive (no re-matching)", async () => {
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ linkedStockEntryId: LINKED_ID }));
    repo.findStockEntriesByAssignment.mockResolvedValue([{ id: "assignmentEntry" }] as never);

    await receiveStockAssignment(ASSIGN_ID, { receivedQuantity: 10 });

    expect(repo.addStockEntryQuantity).toHaveBeenCalledWith("assignmentEntry", 10, null, expect.any(Date), TX);
    expect(repo.findStockEntryById).not.toHaveBeenCalled();
    expect(repo.findStockEntryForTopUp).not.toHaveBeenCalled();
    expect(repo.createStockEntry).not.toHaveBeenCalled();
  });
});

// The Incoming list sends the warehouse manager into the entry form only while there is something
// to fill in. Reporting the wrong status here is what made every top-up receipt bounce the WM out
// of the list and into a form they had already completed.
describe("receiveStockAssignment — stockEntryStatus", () => {
  it("reports draft for a brand-new entry (product details still needed)", async () => {
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ editedName: "New product" }));
    repo.createStockEntry.mockResolvedValue({ id: "newEntry", status: "draft" } as never);

    const res = await receiveStockAssignment(ASSIGN_ID, { receivedQuantity: 10 });

    expect(res.stockEntryStatus).toBe("draft");
  });

  it("reports active when topping up an entry the manager already completed", async () => {
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ linkedStockEntryId: LINKED_ID }));
    repo.findStockEntriesByAssignment.mockResolvedValue([{ id: "assignmentEntry" }] as never);
    repo.addStockEntryQuantity.mockResolvedValue({ id: "assignmentEntry", status: "active" } as never);

    const res = await receiveStockAssignment(ASSIGN_ID, { receivedQuantity: 10 });

    expect(res.stockEntryStatus).toBe("active");
  });

  it("still reports draft when a re-receive lands on an entry left unfinished", async () => {
    // The manager received once, abandoned the form, and came back. There IS still work to do, so
    // the redirect must fire again — the fix keys on the entry's state, not on "is this the first
    // receipt?".
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ linkedStockEntryId: LINKED_ID }));
    repo.findStockEntriesByAssignment.mockResolvedValue([{ id: "assignmentEntry" }] as never);
    repo.addStockEntryQuantity.mockResolvedValue({ id: "assignmentEntry", status: "draft" } as never);

    const res = await receiveStockAssignment(ASSIGN_ID, { receivedQuantity: 10 });

    expect(res.stockEntryStatus).toBe("draft");
  });
});
