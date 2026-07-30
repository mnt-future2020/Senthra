import { beforeEach, describe, expect, it, vi } from "vitest";

// Short-closing a customer delivery: the outstanding balance is never arriving, so the assignment
// reaches a TERMINAL state and stops occupying the warehouse's Incoming queue. Repository + audit are
// mocked so the state machine and the parent-request recompute can be asserted in isolation.
// assertWarehouseAccess is pure and passes for an undefined actor.
vi.mock("./customer.repository.js", () => ({
  findAssignmentById: vi.fn(),
  closeAssignmentShort: vi.fn(),
  findAssignmentsByRequest: vi.fn(),
  updateStockRequestStatus: vi.fn(),
  touchStockRequest: vi.fn(),
  // Touched only by the receive path, mocked so importing the service doesn't explode.
  updateAssignmentReceived: vi.fn(),
  findStockEntriesByAssignment: vi.fn(),
  findStockEntryById: vi.fn(),
  findStockEntryForTopUp: vi.fn(),
  addStockEntryQuantity: vi.fn(),
  createStockEntry: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
const TX = {};
vi.mock("../../lib/prisma.js", () => ({
  prisma: {},
  withTransaction: (fn: (tx: unknown) => unknown) => fn(TX),
  // Runs the body once — the retry only matters against a real Mongo write-conflict, which a mocked
  // repository can't raise. What's under test here is the state machine, not the replay.
  withTransactionRetry: (fn: (tx: unknown) => unknown) => fn(TX),
}));

import * as customerRepo from "./customer.repository.js";
import * as audit from "#modules/audit/audit.service.js";
import { closeAssignmentShort, receiveStockAssignment } from "./customer.service.js";

const ASSIGN_ID = "a".repeat(24);
const REQ_ID = "f".repeat(24);
const WH_ID = "b".repeat(24);

const repo = vi.mocked(customerRepo);

function assignmentRow(over: { status?: string; quantity?: number; receivedQuantity?: number } = {}) {
  return {
    id: ASSIGN_ID,
    warehouseId: WH_ID,
    customerStockRequestId: REQ_ID,
    quantity: over.quantity ?? 50,
    receivedQuantity: over.receivedQuantity ?? 15,
    status: over.status ?? "partially_received",
    warehouse: { id: WH_ID, name: "London Fulfillment Centre", code: "WH-0009" },
    stockRequest: {
      id: REQ_ID,
      customerId: "c".repeat(24),
      name: "item 2",
      editedName: null,
      quantity: 50,
      status: "partially_received",
      linkedStockEntryId: null,
    },
  } as unknown as Awaited<ReturnType<typeof customerRepo.findAssignmentById>>;
}

// The row the repository returns AFTER the write. It must carry the real quantities: the audit line
// is computed from THIS, not from the pre-transaction read, so a thin stub here would hide exactly
// the staleness bug the service now guards against.
const closedRow = (over: { quantity?: number; receivedQuantity?: number } = {}) =>
  ({
    id: ASSIGN_ID,
    status: "closed_short",
    quantity: over.quantity ?? 50,
    receivedQuantity: over.receivedQuantity ?? 15,
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  repo.findAssignmentById.mockResolvedValue(assignmentRow());
  repo.closeAssignmentShort.mockResolvedValue(closedRow());
  repo.findAssignmentsByRequest.mockResolvedValue([
    { status: "closed_short", receivedQuantity: 15 },
  ] as never);
});

describe("closeAssignmentShort — state machine", () => {
  it("closes a partially-received assignment, recording the reason and who closed it", async () => {
    await closeAssignmentShort(ASSIGN_ID, { reason: "Customer only shipped 15" }, { email: "wm@x.com" } as never);

    expect(repo.closeAssignmentShort).toHaveBeenCalledWith(
      ASSIGN_ID,
      "Customer only shipped 15",
      "wm@x.com",
      TX,
    );
  });

  it("closes an assignment nothing ever arrived against", async () => {
    // A delivery cancelled before it started is the same terminal outcome, not a special case.
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ status: "pending", receivedQuantity: 0 }));
    await expect(closeAssignmentShort(ASSIGN_ID, { reason: "Order cancelled" })).resolves.toBeTruthy();
  });

  it("refuses to close an assignment that already arrived in full", async () => {
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ status: "received", receivedQuantity: 50 }));
    await expect(closeAssignmentShort(ASSIGN_ID, { reason: "n/a" })).rejects.toThrow(/already fully received/i);
    expect(repo.closeAssignmentShort).not.toHaveBeenCalled();
  });

  it("refuses to close twice", async () => {
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ status: "closed_short" }));
    await expect(closeAssignmentShort(ASSIGN_ID, { reason: "again" })).rejects.toThrow(/already closed/i);
    expect(repo.closeAssignmentShort).not.toHaveBeenCalled();
  });

  it("rejects a blank / whitespace-only reason", async () => {
    // The zod schema is the first gate, but the service must not depend on it — this is the record
    // of WHY a delivery was closed, and an empty one makes it unanswerable later.
    await expect(closeAssignmentShort(ASSIGN_ID, { reason: "   " })).rejects.toThrow(/reason is required/i);
    expect(repo.closeAssignmentShort).not.toHaveBeenCalled();
  });

  it("surfaces a conflict when a concurrent receive won the race", async () => {
    // The repository's status guard matched no row — someone received into it first.
    repo.closeAssignmentShort.mockResolvedValue(null as never);
    await expect(closeAssignmentShort(ASSIGN_ID, { reason: "gone" })).rejects.toThrow(/just updated by someone else/i);
  });

  it("records an audit entry naming the shortfall AND the reason", async () => {
    await closeAssignmentShort(ASSIGN_ID, { reason: "Lost in transit" });

    const entry = vi.mocked(audit.record).mock.calls[0]?.[0];
    expect(entry?.action).toBe("customer.stock_request.closed_short");
    expect(entry?.targetId).toBe(ASSIGN_ID);
    // 50 assigned, 15 received → 35 outstanding. Both numbers and the reason must be in the trail.
    expect(entry?.targetLabel).toContain("35 of 50");
    expect(entry?.targetLabel).toContain("Lost in transit");
  });

  it("counts the shortfall from the POST-WRITE row, not the stale read", async () => {
    // The status guard deliberately lets a close proceed after a concurrent PARTIAL receipt — that
    // receipt leaves the assignment open and the rest still isn't coming. But it moves
    // receivedQuantity, so the figure read before the transaction is stale. Here the read says 15
    // received while the row that was actually closed says 25: the audit must say 25 of 50 missing,
    // not 35, or the permanent record overstates the loss by whatever landed in between.
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ receivedQuantity: 15 }));
    repo.closeAssignmentShort.mockResolvedValue(closedRow({ receivedQuantity: 25 }));

    await closeAssignmentShort(ASSIGN_ID, { reason: "rest cancelled" });

    const label = vi.mocked(audit.record).mock.calls[0]?.[0]?.targetLabel ?? "";
    expect(label).toContain("25 of 50");
    expect(label).not.toContain("35 of 50");
  });
});

describe("closeAssignmentShort — parent request", () => {
  it("completes the request once every assignment is terminal", async () => {
    // One closed short, one received in full → nothing left to receive.
    repo.findAssignmentsByRequest.mockResolvedValue([
      { status: "closed_short" },
      { status: "received" },
    ] as never);

    await closeAssignmentShort(ASSIGN_ID, { reason: "short" });

    expect(repo.updateStockRequestStatus).toHaveBeenCalledWith(REQ_ID, "completed", TX);
  });

  it("leaves the request partially received while another warehouse is still open", async () => {
    // Units DID arrive on the closed leg, so "partially received" is a true statement.
    repo.findAssignmentsByRequest.mockResolvedValue([
      { status: "closed_short", receivedQuantity: 15 },
      { status: "pending", receivedQuantity: 0 },
    ] as never);

    await closeAssignmentShort(ASSIGN_ID, { reason: "short" });

    expect(repo.updateStockRequestStatus).toHaveBeenCalledWith(REQ_ID, "partially_received", TX);
  });

  it("does NOT claim 'partially received' when nothing has actually arrived", async () => {
    // One warehouse closed short having received NOTHING, another still pending. The customer
    // portal renders this status verbatim — calling it "Partially received" would tell someone
    // stock had arrived when none had. The request simply hasn't moved forward yet.
    repo.findAssignmentsByRequest.mockResolvedValue([
      { status: "closed_short", receivedQuantity: 0 },
      { status: "pending", receivedQuantity: 0 },
    ] as never);

    await closeAssignmentShort(ASSIGN_ID, { reason: "customer never shipped" });

    expect(repo.updateStockRequestStatus).not.toHaveBeenCalled();
    // ...but the request is still WRITTEN. Leaving the status alone must not mean leaving the row
    // untouched: the admin's Stock Submissions list is ordered by `updatedAt`, so skipping the write
    // would bury the submission someone just acted on, and the parent row is also the document
    // concurrent sibling closes rely on colliding over.
    expect(repo.touchStockRequest).toHaveBeenCalledWith(REQ_ID, TX);
  });

  it("completes a request whose every assignment was closed short (nothing ever arrived)", async () => {
    // "Completed" here means no receiving left to do — which is true. Leaving it partially received
    // is what used to strand these requests permanently.
    repo.findAssignmentsByRequest.mockResolvedValue([{ status: "closed_short" }] as never);

    await closeAssignmentShort(ASSIGN_ID, { reason: "customer cancelled" });

    expect(repo.updateStockRequestStatus).toHaveBeenCalledWith(REQ_ID, "completed", TX);
  });
});

describe("receiveStockAssignment — after a short close", () => {
  it("refuses to receive into a closed assignment", async () => {
    // Reopening it would contradict a closure someone signed off with a reason, and would silently
    // un-complete the parent request.
    repo.findAssignmentById.mockResolvedValue(assignmentRow({ status: "closed_short" }));

    await expect(receiveStockAssignment(ASSIGN_ID, { receivedQuantity: 5 })).rejects.toThrow(
      /closed short/i,
    );
    expect(repo.updateAssignmentReceived).not.toHaveBeenCalled();
  });
});
