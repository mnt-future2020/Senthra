import { beforeEach, describe, expect, it, vi } from "vitest";

// Focused on generateStockEntryBarcode's allocation contract: never re-issue a value that is
// physically stuck to stock, and survive a counter that has drifted behind the data. Mock the
// repository + audit so the branches can be asserted in isolation. assertWarehouseAccess is pure
// and passes for an undefined actor.
vi.mock("./customer.repository.js", () => ({
  findStockEntryById: vi.fn(),
  nextStockEntryBarcodeSeq: vi.fn(),
  updateStockEntryBarcode: vi.fn(),
  fastForwardStockEntryBarcodeCounter: vi.fn(),
  isStockEntryBarcodeConflict: vi.fn(),
}));
vi.mock("#modules/audit/audit.service.js", () => ({ record: vi.fn() }));
vi.mock("#modules/settings/settings.service.js", () => ({ getStockCodePrefix: vi.fn(async () => "CSE") }));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {},
  withTransaction: (fn: (tx: unknown) => unknown) => fn({}),
  withTransactionRetry: (fn: (tx: unknown) => unknown) => fn({}),
}));

import * as customerRepo from "./customer.repository.js";
import { generateStockEntryBarcode } from "./customer.service.js";

const ENTRY_ID = "a".repeat(24);
const WH_ID = "b".repeat(24);
const CUST_ID = "c".repeat(24);

const repo = vi.mocked(customerRepo);

function entryRow(over: { barcode?: string | null; barcodeDataUri?: string | null } = {}) {
  return {
    id: ENTRY_ID,
    customerId: CUST_ID,
    warehouseId: WH_ID,
    itemName: "SC/APC Connector",
    quantity: 4,
    status: "draft",
    barcode: over.barcode ?? null,
    barcodeDataUri: over.barcodeDataUri ?? null,
    customer: { id: CUST_ID, name: "LOBBI", customerCode: "CUST-0017" },
    warehouse: { id: WH_ID, name: "London Logistics Hub", code: "WH-0005" },
    category: null,
    receivedBy: null,
    receivedAt: null,
    createdAt: new Date("2026-07-15T00:00:00.000Z"),
  } as unknown as Awaited<ReturnType<typeof customerRepo.findStockEntryById>>;
}

const p2002 = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

beforeEach(() => {
  vi.clearAllMocks();
  repo.isStockEntryBarcodeConflict.mockImplementation((e: unknown) => (e as { code?: string })?.code === "P2002");
  // Echo the allocated value back, so a test can assert WHICH barcode was persisted.
  // Cast: the repo returns Prisma's thenable client type, not a plain Promise.
  repo.updateStockEntryBarcode.mockImplementation(((_id: string, barcode: string, barcodeDataUri: string) =>
    Promise.resolve(entryRow({ barcode, barcodeDataUri }))) as never);
});

describe("generateStockEntryBarcode", () => {
  it("is a no-op when the entry is already barcoded — never burns a number or overwrites a printed label", async () => {
    repo.findStockEntryById.mockResolvedValue(entryRow({ barcode: "CSE-00020", barcodeDataUri: "data:image/png;base64,AAA" }));

    const result = await generateStockEntryBarcode(ENTRY_ID);

    expect(result.barcode).toBe("CSE-00020");
    expect(repo.nextStockEntryBarcodeSeq).not.toHaveBeenCalled();
    expect(repo.updateStockEntryBarcode).not.toHaveBeenCalled();
  });

  it("re-renders the SAME value when the image is missing — never re-allocates a printed label", async () => {
    repo.findStockEntryById.mockResolvedValue(entryRow({ barcode: "CSE-00020", barcodeDataUri: null }));
    repo.nextStockEntryBarcodeSeq.mockResolvedValue(23); // would hand out CSE-00023 if it allocated

    const result = await generateStockEntryBarcode(ENTRY_ID);

    // The sticker on the physical stock still says CSE-00020 — the value must survive.
    expect(result.barcode).toBe("CSE-00020");
    expect(repo.nextStockEntryBarcodeSeq).not.toHaveBeenCalled();
    const [, value, dataUri] = repo.updateStockEntryBarcode.mock.calls[0];
    expect(value).toBe("CSE-00020");
    expect(dataUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("allocates a padded, prefixed barcode and stores the rendered image", async () => {
    repo.findStockEntryById.mockResolvedValue(entryRow());
    repo.nextStockEntryBarcodeSeq.mockResolvedValue(23);

    const result = await generateStockEntryBarcode(ENTRY_ID);

    expect(result.barcode).toBe("CSE-00023");
    const [, value, dataUri] = repo.updateStockEntryBarcode.mock.calls[0];
    expect(value).toBe("CSE-00023");
    expect(dataUri.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("retries past a duplicate barcode (P2002), fast-forwarding the drifted counter", async () => {
    repo.findStockEntryById.mockResolvedValue(entryRow());
    // A counter restored behind the data hands back a live number first, then a free one.
    repo.nextStockEntryBarcodeSeq.mockResolvedValueOnce(20).mockResolvedValueOnce(23);
    repo.updateStockEntryBarcode.mockRejectedValueOnce(p2002);

    const result = await generateStockEntryBarcode(ENTRY_ID);

    expect(result.barcode).toBe("CSE-00023");
    expect(repo.fastForwardStockEntryBarcodeCounter).toHaveBeenCalledTimes(1);
    expect(repo.updateStockEntryBarcode).toHaveBeenCalledTimes(2);
  });

  it("rethrows a non-conflict write failure instead of silently retrying", async () => {
    repo.findStockEntryById.mockResolvedValue(entryRow());
    repo.nextStockEntryBarcodeSeq.mockResolvedValue(23);
    repo.updateStockEntryBarcode.mockRejectedValue(new Error("connection reset"));

    await expect(generateStockEntryBarcode(ENTRY_ID)).rejects.toThrow("connection reset");
    expect(repo.fastForwardStockEntryBarcodeCounter).not.toHaveBeenCalled();
  });

  it("gives up rather than looping forever when every attempt collides", async () => {
    repo.findStockEntryById.mockResolvedValue(entryRow());
    repo.nextStockEntryBarcodeSeq.mockResolvedValue(20);
    repo.updateStockEntryBarcode.mockRejectedValue(p2002);

    await expect(generateStockEntryBarcode(ENTRY_ID)).rejects.toThrow("Could not allocate a unique stock entry barcode.");
    expect(repo.updateStockEntryBarcode).toHaveBeenCalledTimes(5);
  });

  it("404s on a missing entry", async () => {
    repo.findStockEntryById.mockResolvedValue(null);
    await expect(generateStockEntryBarcode(ENTRY_ID)).rejects.toThrow("Stock entry not found.");
  });
});
