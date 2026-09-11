import { beforeEach, describe, expect, it, vi } from "vitest";

// The lean option lists are ACTIVE-only unless a caller asks otherwise. Only history/report filters
// ask — create forms must never offer a deactivated record.
vi.mock("@/lib/api", () => ({
  api: vi.fn().mockResolvedValue({ options: [] }),
  apiFile: vi.fn(),
  LONG_WRITE_TIMEOUT: 0,
}));

import { api } from "@/lib/api";
import { listCustomerOptions } from "./customer.service";
import { listSupplierOptions } from "./supplier.service";
import { listWarehouseOptions } from "./warehouse.service";

beforeEach(() => vi.clearAllMocks());

describe.each([
  ["/customers/options", listCustomerOptions],
  ["/suppliers/options", listSupplierOptions],
  ["/warehouses/options", listWarehouseOptions],
])("%s", (path, list) => {
  it("asks for the active-only list by default", async () => {
    await list();
    expect(api).toHaveBeenLastCalledWith(path);
  });

  it("asks the server to include deactivated records for a history filter", async () => {
    await list({ includeInactive: true });
    expect(api).toHaveBeenLastCalledWith(`${path}?includeInactive=true`);
  });
});
