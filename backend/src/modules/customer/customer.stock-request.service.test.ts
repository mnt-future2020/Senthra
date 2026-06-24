import { beforeEach, describe, expect, it, vi } from "vitest";

// Covers the create-side of a stock submission: how a linked "top-up" id is resolved.
// The security-sensitive bit is that a linked id is ownership-checked against the
// submitting customer and the stored name is derived from that line (never trusted from
// the client). Repo + audit are mocked; assertWarehouseAccess isn't on this path.
vi.mock("./customer.repository.js", () => ({
  findById: vi.fn(),
  findStockEntryById: vi.fn(),
  createStockRequest: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));

import * as customerRepo from "./customer.repository.js";
import { submitStockRequest, createStockRequestForCustomer } from "./customer.service.js";

const CUST_ID = "c".repeat(24);
const OTHER_CUST = "9".repeat(24);
const LINKED_ID = "d".repeat(24);

const repo = vi.mocked(customerRepo);
const portalUser = { userId: "u".repeat(24), name: "Pat", email: "pat@bt-test.com" };

function createdRow(over: Record<string, unknown> = {}) {
  return {
    id: "r".repeat(24),
    name: "SC/APC Connectors",
    editedName: null,
    catalogueItemId: null,
    linkedStockEntryId: null,
    quantity: 5,
    reason: null,
    notes: null,
    status: "pending",
    requestedByName: null,
    reviewedBy: null,
    adminResponse: null,
    reviewedAt: null,
    createdAt: new Date("2026-06-23T00:00:00Z"),
    ...over,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.findById.mockResolvedValue({ id: CUST_ID, name: "LOBBI" } as never);
  repo.createStockRequest.mockResolvedValue(createdRow());
});

describe("submitStockRequest — link resolution", () => {
  it("derives the item name from the linked line and passes the link to the repo", async () => {
    repo.findStockEntryById.mockResolvedValue({
      id: LINKED_ID,
      customerId: CUST_ID,
      itemName: "SC/APC Connectors",
    } as never);

    await submitStockRequest(CUST_ID, portalUser, { linkedStockEntryId: LINKED_ID, quantity: 5 });

    const data = repo.createStockRequest.mock.calls[0]?.[3];
    expect(data).toMatchObject({ name: "SC/APC Connectors", linkedStockEntryId: LINKED_ID, quantity: 5 });
  });

  it("REJECTS a linked id that belongs to a different customer (no row written)", async () => {
    repo.findStockEntryById.mockResolvedValue({
      id: LINKED_ID,
      customerId: OTHER_CUST,
      itemName: "Someone else's stock",
    } as never);

    await expect(
      submitStockRequest(CUST_ID, portalUser, { linkedStockEntryId: LINKED_ID, quantity: 5 }),
    ).rejects.toThrow(/could not be found/i);
    expect(repo.createStockRequest).not.toHaveBeenCalled();
  });

  it("rejects a linked id that no longer exists", async () => {
    repo.findStockEntryById.mockResolvedValue(null as never);
    await expect(
      submitStockRequest(CUST_ID, portalUser, { linkedStockEntryId: LINKED_ID, quantity: 5 }),
    ).rejects.toThrow(/could not be found/i);
    expect(repo.createStockRequest).not.toHaveBeenCalled();
  });

  it("stores a trimmed new name (and no link) for an unlinked submission", async () => {
    await submitStockRequest(CUST_ID, portalUser, { name: "  New cable  ", quantity: 2 });
    const data = repo.createStockRequest.mock.calls[0]?.[3];
    expect(data).toMatchObject({ name: "New cable", linkedStockEntryId: null, quantity: 2 });
    expect(repo.findStockEntryById).not.toHaveBeenCalled();
  });

  it("rejects a submission with neither a name nor a link", async () => {
    await expect(submitStockRequest(CUST_ID, portalUser, { quantity: 2 })).rejects.toThrow(/item name is required/i);
    expect(repo.createStockRequest).not.toHaveBeenCalled();
  });
});

describe("createStockRequestForCustomer (admin) — link resolution", () => {
  it("ownership-checks the link against the target customer", async () => {
    repo.findStockEntryById.mockResolvedValue({
      id: LINKED_ID,
      customerId: OTHER_CUST,
      itemName: "x",
    } as never);
    await expect(
      createStockRequestForCustomer(CUST_ID, "Phone caller", { linkedStockEntryId: LINKED_ID, quantity: 1 }),
    ).rejects.toThrow(/could not be found/i);
    expect(repo.createStockRequest).not.toHaveBeenCalled();
  });

  it("passes the derived name + link through for an owned line", async () => {
    repo.findStockEntryById.mockResolvedValue({
      id: LINKED_ID,
      customerId: CUST_ID,
      itemName: "SC/APC Connectors",
    } as never);
    await createStockRequestForCustomer(CUST_ID, "Phone caller", { linkedStockEntryId: LINKED_ID, quantity: 1 });
    const [, requestedByUserId, requestedByName, data] = repo.createStockRequest.mock.calls[0] ?? [];
    expect(requestedByUserId).toBeNull();
    expect(requestedByName).toBe("Phone caller");
    expect(data).toMatchObject({ name: "SC/APC Connectors", linkedStockEntryId: LINKED_ID });
  });
});
