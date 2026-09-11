import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// #1 — HISTORY and REPORT filters must still offer a customer, supplier or warehouse that has since
// been deactivated: it still owns its requests, movements, stock and report rows. These screens ask the
// option lists for inactive records too and label them "(inactive)". CREATE forms keep the active-only
// list — a deactivated record must never be newly selectable.
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const HISTORY_FILTERS: [string, string[]][] = [
  ["./purchase-requests/PurchaseRequestsView.tsx", ["listSupplierOptions({ includeInactive: true })", "listWarehouseOptions({ includeInactive: true })"]],
  ["./inventory/MovementFeed.tsx", ["listCustomerOptions({ includeInactive: true })"]],
  ["./inventory/StockPositionTable.tsx", ["listCustomerOptions({ includeInactive: true })"]],
  // Custom Reports AND Schedules — both build their customer picker from this hook.
  ["./reports/reportFilterOptions.ts", ["listCustomerOptions({ includeInactive: true })"]],
];

const CREATE_FORMS = [
  "./jobs/JobForm.tsx",
  "./purchase-requests/PurchaseRequestForm.tsx",
  "./purchase-orders/PurchaseOrderForm.tsx",
  "./customers/AssignWarehouseModal.tsx",
  "./customers/AdminStockSubmissionModal.tsx",
  "./customers/AddStockEntryPage.tsx",
];

describe("history filters keep deactivated records", () => {
  it.each(HISTORY_FILTERS)("%s asks for inactive records and labels them", (file, calls) => {
    const src = read(file);
    for (const call of calls) expect(src).toContain(call);
    expect(src).toContain("markInactive(");
  });

  it("Custom Reports and Schedules take their customer list from that hook", () => {
    for (const file of ["./reports/CustomReportsView.tsx", "./reports/ScheduleForm.tsx"]) {
      expect(read(file)).toContain("useReportFilterOptions(");
    }
  });
});

describe("create forms stay active-only", () => {
  it.each(CREATE_FORMS)("%s never asks for inactive records", (file) => {
    expect(read(file)).not.toContain("includeInactive");
  });
});
