import { beforeEach, describe, expect, it, vi } from "vitest";

// The three option endpoints read `?includeInactive=` — the one switch a history filter flips to keep a
// deactivated customer, supplier or warehouse filterable. Absent or false keeps the active-only list the
// create forms pick from. The value is parsed with queryBool, so `?includeInactive=false` is false.
vi.mock("../customer/customer.service.js", () => ({ listCustomerOptions: vi.fn().mockResolvedValue([]) }));
vi.mock("../supplier/supplier.service.js", () => ({ listSupplierOptions: vi.fn().mockResolvedValue([]) }));
vi.mock("../warehouse/warehouse.service.js", () => ({ listWarehouseOptions: vi.fn().mockResolvedValue([]) }));

import * as customerService from "../customer/customer.service.js";
import * as supplierService from "../supplier/supplier.service.js";
import * as warehouseService from "../warehouse/warehouse.service.js";
import { listCustomerOptions } from "../customer/customer.controller.js";
import { listSupplierOptions } from "../supplier/supplier.controller.js";
import { listWarehouseOptions } from "../warehouse/warehouse.controller.js";

type Handler = (req: never, res: never, next: never) => void;

async function call(handler: Handler, query: Record<string, string>) {
  const res = { json: vi.fn() };
  const next = vi.fn();
  handler({ query, params: {} } as never, res as never, next as never);
  await vi.waitFor(() => expect(res.json).toHaveBeenCalled());
  expect(next).not.toHaveBeenCalled();
}

beforeEach(() => vi.clearAllMocks());

describe.each([
  ["customers", listCustomerOptions, () => vi.mocked(customerService.listCustomerOptions).mock.calls.at(-1)?.at(-1)],
  ["suppliers", listSupplierOptions, () => vi.mocked(supplierService.listSupplierOptions).mock.calls.at(-1)?.at(-1)],
  ["warehouses", listWarehouseOptions, () => vi.mocked(warehouseService.listWarehouseOptions).mock.calls.at(-1)?.at(-1)],
])("GET /%s/options", (_name, handler, optionsPassed) => {
  it("is active-only when the caller does not ask", async () => {
    await call(handler as Handler, {});
    expect(optionsPassed()).toEqual({ includeInactive: false });
  });

  it("includes deactivated records for ?includeInactive=true", async () => {
    await call(handler as Handler, { includeInactive: "true" });
    expect(optionsPassed()).toEqual({ includeInactive: true });
  });

  it("reads ?includeInactive=false as false, not as a truthy string", async () => {
    await call(handler as Handler, { includeInactive: "false" });
    expect(optionsPassed()).toEqual({ includeInactive: false });
  });
});

it("the warehouse list is still resolved for the calling actor — scoping is not traded for the flag", async () => {
  await call(listWarehouseOptions as Handler, { includeInactive: "true" });
  const [actor] = vi.mocked(warehouseService.listWarehouseOptions).mock.calls.at(-1) ?? [];
  expect(actor).toBeDefined();
});
