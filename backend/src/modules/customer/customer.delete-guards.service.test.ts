import { beforeEach, describe, expect, it, vi } from "vitest";

// Deleting a customer, or one of their consignment stock entries, must not leave stock or live records
// pointing at something that no longer exists.
//
// Same class of bug as deleting a job that still had stock out with an engineer: the record goes, every
// read filters it away, and the rows that depended on it are stranded. A stock ENTRY is worse than the
// job case — it is HARD-deleted (this model has no archive state, by design) and MongoDB enforces no
// foreign keys, so a delete leaves engineer holdings, kit lines, movement history and damaged balances
// referencing an id nothing resolves.
vi.mock("./customer.repository.js", () => ({
  findById: vi.fn(),
  findStockEntryById: vi.fn(),
  findUsersByCustomer: vi.fn().mockResolvedValue([]),
  softDelete: vi.fn(),
  deleteStockEntry: vi.fn(),
  countStockEntriesWithStockByCustomer: vi.fn().mockResolvedValue(0),
  countEngineerHoldingsByCustomer: vi.fn().mockResolvedValue(0),
  countDamagedByCustomer: vi.fn().mockResolvedValue(0),
  countOpenStockRequestsByCustomer: vi.fn().mockResolvedValue(0),
  countEngineerHoldingsByStockEntry: vi.fn().mockResolvedValue(0),
  countKitLinesByStockEntry: vi.fn().mockResolvedValue(0),
  countMovementLinesByStockEntry: vi.fn().mockResolvedValue(0),
  countDamagedByStockEntry: vi.fn().mockResolvedValue(0),
}));
vi.mock("#modules/job/job.repository.js", () => ({ countOpenByCustomer: vi.fn().mockResolvedValue(0) }));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/auth/session.service.js", () => ({ endAll: vi.fn() }));

import * as customerRepo from "./customer.repository.js";
import * as jobRepo from "#modules/job/job.repository.js";
import { deleteCustomer, deleteStockEntry } from "./customer.service.js";

const CUST_ID = "c".repeat(24);
const ENTRY_ID = "e".repeat(24);
const WH_ID = "w".repeat(24);

const customer = { id: CUST_ID, name: "LOBBI", email: "ops@lobbi.test" };
const entry = (quantity: number) => ({
  id: ENTRY_ID,
  itemName: "mouse123",
  quantity,
  warehouseId: WH_ID,
  customer: { name: "LOBBI" },
});

describe("deleteStockEntry — nothing may be left pointing at a hard-deleted entry", () => {
  const repo = customerRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;

  beforeEach(() => {
    vi.clearAllMocks();
    repo.findStockEntryById.mockResolvedValue(entry(0));
    for (const k of ["countEngineerHoldingsByStockEntry", "countKitLinesByStockEntry", "countMovementLinesByStockEntry", "countDamagedByStockEntry"]) {
      repo[k].mockResolvedValue(0);
    }
  });

  it("deletes an entry that is empty and unreferenced", async () => {
    await expect(deleteStockEntry(ENTRY_ID)).resolves.toBeUndefined();
    expect(repo.deleteStockEntry).toHaveBeenCalledWith(ENTRY_ID);
  });

  // Stock on the shelf is the one loss that leaves no trace at all — no ledger row records it.
  it("REFUSES an entry that still has stock in the warehouse", async () => {
    repo.findStockEntryById.mockResolvedValue(entry(26));
    await expect(deleteStockEntry(ENTRY_ID)).rejects.toThrow(/still has 26 units in stock/i);
    expect(repo.deleteStockEntry).not.toHaveBeenCalled();
  });

  it("says \"1 unit\", not \"1 units\"", async () => {
    repo.findStockEntryById.mockResolvedValue(entry(1));
    await expect(deleteStockEntry(ENTRY_ID)).rejects.toThrow(/1 unit in stock/);
  });

  it("REFUSES while an engineer still holds units of it", async () => {
    repo.countEngineerHoldingsByStockEntry.mockResolvedValue(1);
    await expect(deleteStockEntry(ENTRY_ID)).rejects.toThrow(/out with an engineer/i);
    expect(repo.deleteStockEntry).not.toHaveBeenCalled();
  });

  it("REFUSES while a job's kit list names it", async () => {
    repo.countKitLinesByStockEntry.mockResolvedValue(2);
    await expect(deleteStockEntry(ENTRY_ID)).rejects.toThrow(/kit list/i);
    expect(repo.deleteStockEntry).not.toHaveBeenCalled();
  });

  // Movement history is the audit trail for stock that has already moved; a hard delete orphans it.
  it("REFUSES once goods movements have been recorded against it", async () => {
    repo.countMovementLinesByStockEntry.mockResolvedValue(4);
    await expect(deleteStockEntry(ENTRY_ID)).rejects.toThrow(/goods movements/i);
    expect(repo.deleteStockEntry).not.toHaveBeenCalled();
  });

  it("REFUSES while units of it sit in the damaged pool", async () => {
    repo.countDamagedByStockEntry.mockResolvedValue(3);
    await expect(deleteStockEntry(ENTRY_ID)).rejects.toThrow(/damaged pool/i);
    expect(repo.deleteStockEntry).not.toHaveBeenCalled();
  });
});

describe("deleteCustomer — not while their stock or work is still with us", () => {
  const repo = customerRepo as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const mockOpenJobs = jobRepo.countOpenByCustomer as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    repo.findById.mockResolvedValue(customer);
    repo.findUsersByCustomer.mockResolvedValue([]);
    repo.countStockEntriesWithStockByCustomer.mockResolvedValue(0);
    repo.countEngineerHoldingsByCustomer.mockResolvedValue(0);
    repo.countDamagedByCustomer.mockResolvedValue(0);
    repo.countOpenStockRequestsByCustomer.mockResolvedValue(0);
    mockOpenJobs.mockResolvedValue(0);
  });

  it("deletes a customer with no stock and no live work", async () => {
    await expect(deleteCustomer(CUST_ID)).resolves.toBeUndefined();
    expect(repo.softDelete).toHaveBeenCalledWith(CUST_ID);
  });

  it("REFUSES while their consignment stock is still in our warehouses", async () => {
    repo.countStockEntriesWithStockByCustomer.mockResolvedValue(4);
    await expect(deleteCustomer(CUST_ID)).rejects.toThrow(/stock in 4 entries in your warehouses/i);
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it("REFUSES while they still have jobs in progress", async () => {
    mockOpenJobs.mockResolvedValue(2);
    await expect(deleteCustomer(CUST_ID)).rejects.toThrow(/2 jobs in progress/i);
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  // `countStockEntriesWithStockByCustomer` counts SHELF quantity, and issuing to an engineer
  // decrements exactly that (upsertCustomerHoldingTx moves it onto EngineerCustomerStockHolding).
  // So a company whose entire consignment is out in a van reads 0 entries with stock — and if the
  // job it went out on has since been completed or cancelled, 0 open jobs too. Both original checks
  // pass and the customer is deleted while we are physically holding their goods, leaving the
  // holding rows naming a company no lookup resolves: the exact harm this guard exists to prevent,
  // reached by the field path instead of the shelf path.
  it("REFUSES while an engineer is still out with their stock", async () => {
    repo.countEngineerHoldingsByCustomer.mockResolvedValue(2);
    await expect(deleteCustomer(CUST_ID)).rejects.toThrow(/out with (an )?engineer/i);
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  // DamagedStockBalance carries its own customerId snapshot and outlives the entry it came from,
  // so a customer can hold nothing anywhere except the damaged pool and still be undeleteable.
  it("REFUSES while their stock sits in the damaged pool", async () => {
    repo.countDamagedByCustomer.mockResolvedValue(5);
    await expect(deleteCustomer(CUST_ID)).rejects.toThrow(/damaged pool/i);
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  // The fourth place their stock lives, and the only one that is not stock we HOLD: stock they have
  // sent. An approved or assigned request that hasn't landed has created no entry, no engineer
  // holding and no damaged unit, so all three checks above read 0 for a company with a delivery in
  // transit — and stock requests are independent of jobs, so the open-jobs check reads 0 too. Every
  // guard passes and the customer is deleted while their goods are on the way to us.
  it("REFUSES while they still have a stock request open", async () => {
    repo.countOpenStockRequestsByCustomer.mockResolvedValue(3);
    await expect(deleteCustomer(CUST_ID)).rejects.toThrow(/3 open stock requests/i);
    expect(repo.softDelete).not.toHaveBeenCalled();
  });

  it("gets the singular right for both messages", async () => {
    repo.countStockEntriesWithStockByCustomer.mockResolvedValue(1);
    await expect(deleteCustomer(CUST_ID)).rejects.toThrow(/stock in 1 entry in your warehouses/i);
    repo.countStockEntriesWithStockByCustomer.mockResolvedValue(0);
    mockOpenJobs.mockResolvedValue(1);
    await expect(deleteCustomer(CUST_ID)).rejects.toThrow(/1 job in progress/i);
  });
});
