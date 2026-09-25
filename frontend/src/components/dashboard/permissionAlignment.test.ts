import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// ── The permission-mismatch audit, pinned in the UI ──────────────────────────────────────────────
//
// The bug class: a screen visible under one permission quietly loads a panel, tab or dropdown from an
// endpoint gated on ANOTHER. The viewer got a permission toast they could do nothing about, an error
// panel, or — worst — an empty dropdown that read as "there is no data". The server's guards are the
// source of truth (backend permission-alignment test); these pin that each screen now either reads a
// lean endpoint its own permission opens, or HIDES the control for a viewer who cannot read it.
//
// Read from source rather than rendered, like pageGate.test and masterDataSelects.test: there is no
// jsdom here, and the failure is a gate someone forgot — which is exactly what a source check sees.

const SRC = join(process.cwd(), "src");
const stripComments = (s: string) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // /\r?\n/, not "\n": a CRLF line keeps its "\r", and `.` cannot match "\r", so the
    // `//…$` pattern below would never reach the line's end and would leave the comment in
    // as if it were code.
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
const read = (rel: string) => stripComments(readFileSync(join(SRC, rel), "utf8"));
const DASH = "components/dashboard";

describe("P1 — seeded roles no longer meet an error", () => {
  it("#1 #23 the Jobs list reads the lean customer + project options", () => {
    const src = read(`${DASH}/jobs/JobsView.tsx`);
    expect(src).toContain("listCustomerOptions");
    expect(src).toContain("listCustomerProjectOptions(customer)");
    expect(src).not.toMatch(/\blistCustomers\(/);
    expect(src).not.toMatch(/\blistCustomerProjects\(/);
  });

  it("#2 the Purchase Orders list reads the lean supplier + warehouse options", () => {
    const src = read(`${DASH}/purchase-orders/PurchaseOrdersView.tsx`);
    expect(src).toContain("load: listSupplierOptions");
    expect(src).toContain("load: listWarehouseOptions");
    expect(src).not.toMatch(/\blistSuppliers\(|\blistWarehouses\(/);
  });

  it("#3 #22 the PO detail's hire panels are drawn only for rentals.view", () => {
    const src = read(`${DASH}/purchase-orders/PurchaseOrderDetail.tsx`);
    expect(src).toContain('const canSeeHires = can("rentals.view")');
    expect(src.match(/po\.rentalItems\.length > 0 && canSeeHires/g)?.length).toBe(2);
    expect(src).not.toMatch(/po\.rentalItems\.length > 0 && \(\s*<section/);
  });

  it.each([
    ["#4 Supplier detail", "suppliers/SupplierDetail.tsx", 'can("audit.view") ? tab$("audit", "Audit trail")'],
    ["#5 Warehouse detail", "warehouses/WarehouseDetail.tsx", '{ key: "audit", label: "Audit trail", perms: ["audit.view"] }'],
    ["#6 IRM item detail", "irm/IrmItemDetail.tsx", 't.key !== "audit" || can("audit.view")'],
    ["#7 GRN detail", "goods-in/GoodsReceiptDetail.tsx", 'can("audit.view") ? (["audit"] as Tab[])'],
  ])("%s gates its Audit trail tab on audit.view", (_where, file, gate) => {
    expect(read(`${DASH}/${file}`)).toContain(gate);
  });

  it("#6 #7 the tab strips render the GATED list, not a literal one", () => {
    expect(read(`${DASH}/irm/IrmItemDetail.tsx`)).toContain("visibleTabs.map(");
    expect(read(`${DASH}/goods-in/GoodsReceiptDetail.tsx`)).not.toContain('(["overview", "attachments", "audit"] as Tab[])');
  });

  it("#8 #9 the warehouse Inventory tab gates each pool on its own read", () => {
    const src = read(`${DASH}/warehouses/WarehouseDetail.tsx`);
    expect(src).toContain("stockPoolAccess(can)");
    expect(src).toContain('{ key: "inventory", label: "Inventory", perms: INVENTORY_TAB_PERMS');
    expect(src).not.toMatch(/customer:\s*true/);
  });

  it("#10 the Inventory Hub's Movements lens needs inventory.history", () => {
    expect(read(`${DASH}/inventory/InventoryHub.tsx`)).toContain('{ id: "movements", label: "Movements", perm: "inventory.history" }');
  });
});

describe("P2 — seeded roles no longer meet an empty filter", () => {
  it.each([
    ["#15 IRM catalogue", "irm/IrmItemsView.tsx"],
    ["#16 Rentals → On hire", "rentals/OnHireView.tsx"],
    ["#17 Expected deliveries", "warehouses/ExpectedDeliveries.tsx"],
    ["#18 Goods receipts", "goods-in/GoodsReceiptsView.tsx"],
    ["#29 Finance", "reports/FinanceView.tsx"],
  ])("%s filters by supplier from the lean options", (_where, file) => {
    const src = read(`${DASH}/${file}`);
    expect(src).toContain("listSupplierOptions()");
    expect(src).not.toMatch(/\blistSuppliers\(/);
  });

  it.each([
    ["#19 Goods Management", "goods-management/GoodsManagementTab.tsx", "showCustomerFilter && ("],
    ["#20 Movements", "inventory/MovementFeed.tsx", "showCustomerFilter && ("],
    ["#21 Stock positions", "inventory/StockPositionTable.tsx", 'filters.includes("customer") && canPickCustomers('],
  ])("%s HIDES its customer filter from a viewer the server would refuse (the Warehouse Manager)", (_where, file, gate) => {
    const src = read(`${DASH}/${file}`);
    expect(src).toContain(gate);
    expect(src).toContain("canPickCustomers(can, ");
    // …and when shown it is the complete lean list, not a 100-row page of the directory.
    expect(src).not.toMatch(/\blistCustomers\(/);
  });

  it("#19 Goods Management hides its company-wide site search the same way", () => {
    const src = read(`${DASH}/goods-management/GoodsManagementTab.tsx`);
    expect(src).toContain("canSearchSites(can, scoped)");
    expect(src).toContain("showSiteFilter && (");
  });
});

describe("P3 — custom roles", () => {
  it("#24 the job form reads complete projects and SEARCHES the customer's sites", () => {
    const src = read(`${DASH}/jobs/JobForm.tsx`);
    expect(src).toContain("listCustomerProjectOptions(customerId)");
    expect(src).toContain("searchCustomerSiteOptions(customerId, term)");
    expect(src).toMatch(/<SitePicker\s+variant="form"/);
    expect(src).not.toMatch(/\blistCustomerSites\(|\blistCustomerProjects\(/);
  });

  it("#24 a failed project load is said out loud — project is required", () => {
    expect(read(`${DASH}/jobs/JobForm.tsx`)).toContain("Couldn't load this customer's projects");
  });

  it("#26 item warehouse stock comes from the lean, cost-free endpoint", () => {
    const src = read("services/inventory.service.ts");
    expect(src).toContain("/inventory/items/${irmItemId}/warehouse-stock");
    expect(src).not.toMatch(/listItemWarehouseStock[\s\S]{0,300}\/inventory\$\{listQs/);
  });

  it.each(["reports/CustomReportsView.tsx", "reports/ScheduleForm.tsx"])(
    "#28 %s searches items and hides the customer pickers from a scoped reporter",
    (file) => {
      const src = read(`${DASH}/${file}`);
      expect(src).toContain("<IrmItemPicker");
      expect(src).toContain("canPickCustomers(can, ");
    },
  );

  it("#28 the report option loader reads only the complete lean lists", () => {
    const src = read(`${DASH}/reports/reportFilterOptions.ts`);
    // Customers include deactivated ones — a report reads history (see historicalFilters.test.ts).
    expect(src).toContain("listCustomerOptions({ includeInactive: true })");
    expect(src).toContain("listWarehouseOptions()");
    expect(src).toContain("listCustomerProjectOptions(customerId)");
    expect(src).not.toMatch(/\blistCustomers\(|\blistWarehouses\(|\blistCustomerProjects\(/);
  });

  it.each(["purchase-requests/PurchaseRequestForm.tsx", "purchase-orders/PurchaseOrderForm.tsx"])(
    "#30 %s picks its delivery warehouse from the delivery options",
    (file) => {
      const src = read(`${DASH}/${file}`);
      expect(src).toContain("listWarehouseDeliveryOptions");
      expect(src).not.toMatch(/\blistWarehouses\(/);
    },
  );

  it("#30 the Purchase Requests list filters from the lean options", () => {
    const src = read(`${DASH}/purchase-requests/PurchaseRequestsView.tsx`);
    // …including deactivated suppliers and warehouses: past requests still reference them.
    expect(src).toContain("listSupplierOptions({ includeInactive: true })");
    expect(src).toContain("listWarehouseOptions({ includeInactive: true })");
    expect(src).not.toMatch(/\blistSuppliers\(|\blistWarehouses\(/);
  });

  it.each([
    "customers/AssignWarehouseModal.tsx",
    "customers/AdminStockSubmissionModal.tsx",
    "customers/AddStockEntryPage.tsx",
    "customers/CustomerDetail.tsx",
  ])("#31 %s picks warehouses from the lean, scoped options", (file) => {
    const src = read(`${DASH}/${file}`);
    expect(src).toContain("listWarehouseOptions");
    expect(src).not.toMatch(/\blistWarehouses\(/);
  });

  it("#32 the Users list neither asks for nor draws a role filter it cannot fill", () => {
    const src = read(`${DASH}/users-roles/users/UsersView.tsx`);
    expect(src).toContain('can("roles.view") || can("users.create") || can("users.edit")');
    expect(src).toContain("if (!canFilterByRole) return;");
    expect(src).toContain("{canFilterByRole && (");
  });

  it("#34 the engineer dashboard draws Recent activity only with the ledger permission", () => {
    const src = read(`${DASH}/engineer/EngineerDashboard.tsx`);
    expect(src).toContain('can("engineer.inventory.view")');
    expect(src).toContain("useEngineerOverview(canInventory)");
    expect(src).toContain("{canInventory && <RecentActivityCard");
    expect(read(`${DASH}/engineer/overview/useEngineerOverview.ts`)).toContain("loadRecent");
  });
});

describe("#35 Receive / Close short", () => {
  it("are offered only to a viewer holding stock_requests.complete", () => {
    const src = read(`${DASH}/warehouses/WarehouseDetail.tsx`);
    expect(src).toContain('const canComplete = can("stock_requests.complete")');
    expect(src).toContain("remaining > 0 && canComplete && (");
  });
});

// ── P4: no picker is fed a page of a directory read again ────────────────────────────────────────
//
// The list endpoints clamp pageSize to 100, so a dropdown fed `listX({ pageSize: 200 })` silently lost
// every record past the hundredth. Every picker now reads a COMPLETE lean list or searches. The only
// callers left are the directory screens themselves (paged tables) and the inventory forms whose
// warehouse pickers were deliberately left unchanged (every role that can reach them holds
// warehouse.view, and they already page at the cap rather than past it).

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}
const SCANNED = [...sourceFiles(join(SRC, "components")), ...sourceFiles(join(SRC, "app")), ...sourceFiles(join(SRC, "hooks"))];
const rel = (f: string) => relative(SRC, f).replace(/\\/g, "/");

const ALLOWED: Record<string, string[]> = {
  listCustomers: [`${DASH}/customers/CustomersView.tsx`],
  listSuppliers: [`${DASH}/suppliers/SuppliersView.tsx`],
  // The customer detail's own paged tabs.
  listCustomerProjects: [`${DASH}/customers/CustomerDetail.tsx`],
  listCustomerSites: [`${DASH}/customers/CustomerDetail.tsx`],
  listWarehouses: [
    `${DASH}/warehouses/WarehousesView.tsx`,
    `${DASH}/inventory/InventoryView.tsx`,
    `${DASH}/inventory/StockPositionTable.tsx`,
    `${DASH}/inventory/TransferForm.tsx`,
    `${DASH}/inventory/CustomerTransferForm.tsx`,
    `${DASH}/inventory/AddStockForm.tsx`,
    `${DASH}/inventory/AdjustStockForm.tsx`,
  ],
};

describe("P4 — the directory list reads feed no new picker", () => {
  it.each(Object.keys(ALLOWED))("%s is called only by its own screen (or a documented exception)", (fn) => {
    const callers = SCANNED.filter((f) => new RegExp(`\\b${fn}\\(`).test(stripComments(readFileSync(f, "utf8")))).map(rel);
    expect(callers.filter((c) => !ALLOWED[fn]!.includes(c))).toEqual([]);
  });
});

// ── No internal identifier in a user-facing message ──────────────────────────────────────────────
//
// useReferenceData words its toast from the source's `label` ("Couldn't load {label} …"). The PO list
// shipped labels "po-suppliers" / "po-warehouses", so a Warehouse Manager was told they could not view
// "po-suppliers". Every label must be plain words.

describe("reference-data labels are plain words", () => {
  const labels = SCANNED.flatMap((f) => {
    const src = readFileSync(f, "utf8");
    return [...src.matchAll(/label:\s*"([^"]+)",(?:\s*\/\/[^\n]*)*\s*load:/g)].map((m) => ({ file: rel(f), label: m[1]! }));
  });

  it("finds the labels to check", () => {
    expect(labels.length).toBeGreaterThan(20);
  });

  it("none is a code-style identifier", () => {
    const bad = labels.filter((l) => !/^[a-z][a-z ]*[a-z]$/.test(l.label));
    expect(bad).toEqual([]);
  });
});
