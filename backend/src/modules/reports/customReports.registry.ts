// ── THE Custom Report catalogue — what may be asked for, and by whom ──────────────────────────
//
// The client's FLOW 10B lets a user pick a report type and a set of filters. The dangerous reading of
// that is "let the client describe a query"; this registry is the safe one. The frontend selects a
// KEY from this list and nothing else — it never names a table, a column, a sort or a join, so there
// is no surface on which to construct an arbitrary query.
//
// Adding a report later = one entry here plus its runner. Nothing else changes.
//
// Deliberately NOT a home for financial reports. Spend, VAT and cost breakdowns live in the Finance
// module and its canonical calculation layer; a report that needed money would reuse THAT rather than
// grow a second accounting path here. `financial: true` exists so such a report can be added one day
// and be gated correctly the moment it is — today nothing sets it.

/** Every filter a custom report can accept. A report declares the subset it actually honours. */
export const CUSTOM_REPORT_FILTERS = [
  "dateFrom",
  "dateTo",
  "customerId",
  "projectId",
  "warehouseId",
  "irmItemId",
  "engineerId",
  "itemKind",
] as const;
export type CustomReportFilter = (typeof CUSTOM_REPORT_FILTERS)[number];

export interface CustomReportColumn {
  /** Key on the row object the runner returns. */
  key: string;
  /** Column heading, shared by the screen, the CSV and the XLSX so all three read identically. */
  header: string;
  /** Right-align and format as a whole number. */
  numeric?: boolean;
}

export interface CustomReportDef {
  key: string;
  label: string;
  description: string;
  /** Only these filters are accepted; anything else on the query string is REJECTED, not ignored. */
  filters: readonly CustomReportFilter[];
  columns: readonly CustomReportColumn[];
  /** Which authoritative source answers it — documentation, and the runner's own switch. */
  source: string;
  /**
   * Whether a CUSTOMER may run this report through the portal.
   *
   * False by default and true only where the report has been built to be customer-safe: scoped to
   * one customer server-side, and carrying no price, cost, supplier or VAT field at all. This is a
   * data-visibility boundary, not a UI preference — see reports.security.test.ts.
   */
  customerVisible: boolean;
  /**
   * True if any column carries money. Gates on `reports.finance.view` in addition to `reports.view`.
   * Nothing sets it today — money belongs to the Finance module — and the flag exists so that if a
   * costed report is ever added it cannot ship without the finance gate.
   */
  financial: boolean;
  /**
   * Whether this report's SOURCE can be narrowed to an actor's warehouses.
   *
   * A property of the DATA MODEL, not a preference. `movement.service` already draws this line: it
   * withholds the engineer-van ledgers from a warehouse-scoped caller because those rows carry no
   * `warehouseId` and so "there is nothing to check them against". The same fact decides this flag.
   *
   * `false` means a warehouse-scoped actor may not run the report AT ALL — because the only two
   * alternatives are worse. Serving it unscoped hands a warehouse-restricted user the company-wide
   * field position, which is a wider disclosure than the scope exists to prevent. Scoping it would
   * require an engineer→warehouse mapping that this system does not have and that nobody has
   * specified; guessing one (assigned warehouse, last known site, issuing warehouse) would invent an
   * accounting rule inside a report.
   *
   * Unrestricted actors are unaffected — `getAccessibleWarehouseIds` returns null for them, so this
   * flag never applies.
   */
  warehouseScopable: boolean;
}

/**
 * Stock Movement — the report FLOW 10B illustrates by example:
 *   "BT — May 2026 — How many SFP cards dispatched?"  →  Item | Qty | Date | Engineer | Site
 *
 * Answered by the EXISTING unified movement feed, which already reconciles four append-only ledgers
 * (warehouse, engineer-held, job movements, customer stock in a van) behind one date-ranged,
 * warehouse-scoped read. No new ledger, no new query: a physical event that touches two ledgers is
 * already de-duplicated there by a synthetic `${ledger}:${rawId}` identity, and every row carries its
 * `sourceType`/`sourceId` so the origin is always nameable.
 */
const STOCK_MOVEMENT: CustomReportDef = {
  key: "stock_movement",
  label: "Stock Movement",
  description: "Every stock movement in the period — issued, returned, transferred, received or written off.",
  filters: ["dateFrom", "dateTo", "customerId", "warehouseId", "irmItemId", "engineerId", "itemKind"],
  columns: [
    { key: "date", header: "Date" },
    { key: "itemName", header: "Item" },
    { key: "itemCode", header: "Item Code" },
    { key: "movement", header: "Movement" },
    { key: "quantity", header: "Quantity", numeric: true },
    { key: "location", header: "Site / Warehouse" },
    { key: "engineerName", header: "Engineer" },
    { key: "customerName", header: "Customer" },
    { key: "reference", header: "Reference" },
    { key: "source", header: "Source" },
  ],
  source: "inventory/movement.service (unified ledger feed)",
  // Customer stock movements ARE the customer's own data and carry no money — this is the report
  // FLOW 9 puts in the portal. The runner scopes it to the calling customer server-side.
  customerVisible: true,
  financial: false,
  // The movement feed narrows the warehouse ledgers by `scopeWarehouseIds` and drops the van ledgers
  // outright for a scoped caller, so what this report returns is genuinely the actor's warehouses.
  warehouseScopable: true,
};

/**
 * Project Activity — what has moved against a customer's projects.
 *
 * `Job.projectId` is a REQUIRED relation, so a job always resolves to exactly one project; movements
 * reach a project through the job they were issued against. Reported as ACTIVITY (quantities), never
 * as project COST: no movement ledger carries a price, and valuing at the catalogue's standard cost
 * would be inventing an accounting basis nobody agreed. Procurement cost by project already exists,
 * correctly, in Finance.
 */
const PROJECT_ACTIVITY: CustomReportDef = {
  key: "project_activity",
  label: "Project Activity",
  description: "Stock movements attributed to a project, through the jobs raised under it. Quantities only — project COST lives in Finance.",
  filters: ["dateFrom", "dateTo", "customerId", "projectId", "warehouseId", "irmItemId"],
  columns: [
    { key: "date", header: "Date" },
    { key: "projectName", header: "Project" },
    { key: "jobNumber", header: "Job" },
    { key: "itemName", header: "Item" },
    { key: "quantity", header: "Quantity", numeric: true },
    { key: "engineerName", header: "Engineer" },
    { key: "customerName", header: "Customer" },
    { key: "movement", header: "Movement" },
  ],
  source: "goods-management job stock movements → Job → CustomerProject",
  customerVisible: false,
  financial: false,
  // Same feed, same scoping — the project is resolved from movements that were already narrowed.
  warehouseScopable: true,
};

/**
 * Engineer Stock — what each engineer is currently holding.
 *
 * A position report, not a movement one: the question it answers is "what is on Karthik's van right
 * now", which the balance tables answer directly. Deliberately carries NO value column — engineer-held
 * stock is never valued anywhere in this system, and inventing a figure here would be the first place
 * it happened.
 */
const ENGINEER_STOCK: CustomReportDef = {
  key: "engineer_stock",
  label: "Engineer Stock",
  description: "What each engineer is currently holding. Quantities only.",
  filters: ["engineerId", "irmItemId"],
  columns: [
    { key: "engineerName", header: "Engineer" },
    { key: "itemName", header: "Item" },
    { key: "itemCode", header: "Item Code" },
    { key: "quantity", header: "Quantity", numeric: true },
  ],
  source: "engineer stock balances",
  customerVisible: false,
  financial: false,
  /**
   * NOT scopable, and this is a fact about the schema rather than a decision taken here.
   *
   * `EngineerStockBalance` is keyed `@@unique([irmItemId, engineerId])` and holds no `warehouseId`;
   * neither does `EngineerStockTransaction`. Stock on a van is held by a PERSON, not a building, and
   * the model says so. There is therefore no authoritative answer to "which engineer holdings belong
   * to Warehouse X" — `UserWarehouseAssignment` records which warehouses a scoped user may ACCESS,
   * which is not the same question and must not be used as one.
   *
   * So a warehouse-scoped user is refused this report. Neither the client's FLOW 10B (which names
   * only "Stock Movement" as a report type) nor any other requirement asks for scoped engineer
   * visibility, and inventing a mapping to satisfy an unstated requirement is how a reporting screen
   * becomes the place a new accounting rule was quietly born.
   */
  warehouseScopable: false,
};

export const CUSTOM_REPORTS: readonly CustomReportDef[] = [STOCK_MOVEMENT, PROJECT_ACTIVITY, ENGINEER_STOCK];

/**
 * Report types NOT built, and why — recorded so nobody adds an empty dropdown entry for them.
 *
 *   Customer Report   — the customer-facing view of Stock Movement; served by the same key through
 *                       the portal route, scoped to the caller. Not a separate type.
 *   Supplier Report   — supplier SPEND is Finance (already built). A non-financial supplier report
 *                       would be delivery performance, which needs on-time data nothing computes yet.
 *   Item / Inventory  — the Inventory module already ships a filtered, exportable position list; a
 *                       second one here would be a duplicate surface, not a new capability.
 *   Job / Project COST — no movement ledger carries a price. NOT SUPPORTED without inventing a basis.
 */
export const UNSUPPORTED_REPORTS = ["supplier_performance", "job_cost", "project_cost", "stock_valuation"] as const;

export const findReport = (key: string): CustomReportDef | undefined => CUSTOM_REPORTS.find((r) => r.key === key);

/**
 * Reports this actor may run. Customers get the customer-safe subset and nothing else.
 *
 * THE single answer, used by both the catalogue endpoint and the runner's own authorisation check —
 * so what the dropdown offers and what the server will accept cannot drift apart, and hiding a report
 * from the picker is never the only thing stopping a direct request for it.
 */
export function reportsFor(opts: {
  isCustomer: boolean;
  canFinance: boolean;
  /** A staff principal restricted to assigned warehouses. Customers are never warehouse-scoped. */
  isWarehouseScoped?: boolean;
}): CustomReportDef[] {
  return CUSTOM_REPORTS.filter((r) => {
    if (opts.isCustomer) return r.customerVisible;
    // A report whose source has no warehouse dimension cannot be served to a scoped actor at all.
    if (opts.isWarehouseScoped && !r.warehouseScopable) return false;
    return r.financial ? opts.canFinance : true;
  });
}
