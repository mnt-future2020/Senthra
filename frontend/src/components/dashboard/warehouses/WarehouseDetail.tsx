"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Boxes, Eye, Loader2, MapPin, Pencil, Power, ScrollText } from "lucide-react";

import * as warehouseService from "@/services/warehouse.service";
import * as customerService from "@/services/customer.service";
import * as auditService from "@/services/audit.service";
import { Select } from "@/components/ui/Select";
import { Pagination } from "@/components/ui/Pagination";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { actionLabel, actionTone, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { AuditTrailSkeleton } from "@/components/dashboard/audit/AuditTrailSkeleton";
import { ReceiveStockModal } from "@/components/dashboard/customers/ReceiveStockModal";
import { InventoryView } from "@/components/dashboard/inventory/InventoryView";
import { GoodsReceiptsView } from "@/components/dashboard/goods-in/GoodsReceiptsView";
import { GoodsManagementTab } from "@/components/dashboard/goods-management/GoodsManagementTab";
import { VanRequestsWorkspace } from "@/components/dashboard/van-requests/VanRequestsWorkspace";
import { DemandTab } from "@/components/dashboard/goods-management/DemandTab";
import { DamagedStockView } from "@/components/dashboard/goods-management/DamagedStockView";
import { ExpectedDeliveries } from "./ExpectedDeliveries";
import type { AuditEntry } from "@/types/audit";
import type { CustomerStockEntry, PendingStockItem, WarehouseAssignment } from "@/types/customer";
import type { Warehouse } from "@/types/warehouse";
import type { UserStatus } from "@/types/user";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// First-load placeholder mirroring a data table — keeps the warehouse panes' loading style
// consistent with the GRN list (skeleton rows, not a spinner). Pass the column headers + min width.
function TableSkeleton({ headers, minWidth }: { headers: string[]; minWidth: number }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            {headers.map((h, i) => (<th key={i} className="px-4 py-3">{h}</th>))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {headers.map((_h, j) => (<td key={j} className="px-4 py-3"><Skeleton className="h-3 w-20" /></td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// "Incoming stock" is a receive worklist (what's still arriving), so it sits before the
// "Inventory" holdings view — you receive first, then it shows up in stock. The "Inventory"
// tab holds BOTH stock pools behind an inner toggle: company-owned IRM inventory (the
// catalogue's per-warehouse balances) and customer consignment stock the customer shipped in.
// (Incoming tab is gated by stock_requests.view; customer stock under Inventory is visible to
// all; the IRM pool inside is gated by inventory.view.)
type Tab = "overview" | "inventory" | "incoming" | "goods" | "van" | "demand" | "transactions" | "audit";
// `perms` is an anyOf gate. "Incoming stock" hosts BOTH receiving flows behind an inner toggle —
// company goods receipts (goods_in.view) and customer consignment intake (stock_requests.view) — so
// it shows if the user can see EITHER pool.
// `fill: true` marks a tab whose content is a full-height inline-scroll layout (flex h-full → the
// table body scrolls internally): the content region gives it a bounded, non-scrolling box. Omit it
// for card-style tabs (overview / transactions / audit) that scroll the whole page naturally. Set it
// declaratively per tab rather than string-matching keys in the render, so a new tab can't silently
// clip by being missed off a hardcoded list.
const TABS: { key: Tab; label: string; perms?: string[]; fill?: boolean }[] = [
  { key: "overview", label: "Overview" },
  { key: "incoming", label: "Incoming stock", perms: ["goods_in.view", "stock_requests.view"], fill: true },
  { key: "inventory", label: "Inventory", fill: true },
  { key: "goods", label: "Goods Management", perms: ["goods_management.view"], fill: true },
  { key: "van", label: "Field Stock Requests", perms: ["van_stock_request.review"], fill: true },
  { key: "demand", label: "Demand", perms: ["inventory.view"], fill: true },
  { key: "transactions", label: "Transactions" },
  { key: "audit", label: "Audit trail" },
];

export function WarehouseDetail({ initial }: { initial: Warehouse }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [w, setW] = React.useState<Warehouse>(initial);
  const [busy, setBusy] = React.useState(false);
  const canEdit = can("warehouse.edit");

  const visibleTabs = TABS.filter((t) => !t.perms || t.perms.some((p) => can(p)));
  const requestedTab = searchParams.get("tab");
  const activeTab = visibleTabs.find((t) => t.key === requestedTab) ?? visibleTabs[0];
  const tab: Tab = activeTab?.key ?? "overview";

  const toggleStatus = async () => {
    const next = w.status === "active" ? "inactive" : "active";
    setBusy(true);
    try {
      const updated = await warehouseService.updateWarehouse(w.id, { status: next });
      setW(updated);
      pushToast(next === "inactive" ? "Warehouse deactivated." : "Warehouse activated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the warehouse.", "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <DetailHeader
        storageKey="warehouse-detail"
        title={w.name}
        badges={
          <>
            <StatusBadge status={w.status as UserStatus} />
            {w.isDefault && (
              <span className="rounded-full bg-[var(--accent-10)] px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--accent)]">
                Default
              </span>
            )}
          </>
        }
        meta={
          <>
            <span className="font-mono">{w.code}</span>
            <span aria-hidden>·</span>
            <span>{w.type?.name ?? "—"}</span>
          </>
        }
        actions={
          canEdit && (
            <>
              <button
                type="button"
                onClick={toggleStatus}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
                {w.status === "active" ? "Deactivate" : "Activate"}
              </button>
              <button
                type="button"
                onClick={() => router.push(`/dashboard/warehouses/${w.code}/edit`)}
                className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
              >
                <Pencil className="h-3.5 w-3.5" /> Edit
              </button>
            </>
          )
        }
      />

      {/* Tabs */}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-[var(--border)]">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => router.replace(`/dashboard/warehouses/${w.code}?tab=${t.key}`, { scroll: false })}
            className={`shrink-0 border-b-2 px-3.5 py-2.5 text-xs font-bold transition-colors ${
              tab === t.key
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* A `fill` tab owns its own scrolling (full-height inline-scroll layout) → give it a bounded,
          non-scrolling box so only its table body scrolls (sticky headers, pinned pagination).
          Card-style tabs scroll as a whole page. Driven by the tab's declarative `fill` flag. */}
      <div className={`min-h-0 flex-1 ${activeTab?.fill ? "overflow-hidden" : "overflow-auto"}`}>
        {tab === "overview" && <Overview w={w} />}
        {tab === "inventory" && <StockTab warehouseCode={w.code} warehouseId={w.id} router={router} />}
        {tab === "incoming" && <IncomingTab warehouseCode={w.code} warehouseId={w.id} router={router} pushToast={pushToast} />}
        {tab === "goods" && <GoodsManagementTab warehouseId={w.id} warehouseCode={w.code} router={router} />}
        {tab === "van" && <VanRequestsWorkspace warehouse={{ id: w.id, name: w.name, code: w.code }} />}
        {tab === "demand" && <DemandTab warehouseId={w.id} />}
        {tab === "transactions" && (
          <Placeholder
            icon={Activity}
            title="Transactions"
            body="Goods in, goods out, transfers and adjustments for this warehouse will be listed here once inventory movements are live."
          />
        )}
        {tab === "audit" && <AuditTrail warehouseId={w.id} />}
      </div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5">
      <h2 className="mb-4 text-sm font-extrabold text-[var(--ink)]">{title}</h2>
      {children}
    </section>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <div className="mt-0.5 text-sm text-[var(--ink)]">{children || "—"}</div>
    </div>
  );
}

function Overview({ w }: { w: Warehouse }) {
  const addressLines = [w.addressLine1, w.addressLine2, w.city, w.county, w.postcode, w.country]
    .map((l) => l?.trim())
    .filter(Boolean);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Location">
        <div className="space-y-3">
          <Field label="Address">
            {addressLines.length ? (
              <div className="space-y-0.5">
                {addressLines.map((l, i) => (
                  <div key={i}>{l}</div>
                ))}
              </div>
            ) : (
              ""
            )}
          </Field>
          <Field label="Coordinates">
            {w.latitude != null && w.longitude != null ? (
              <span className="inline-flex items-center gap-1.5 text-[var(--muted)]">
                <MapPin className="h-3.5 w-3.5 text-[var(--accent)]" />
                {w.latitude.toFixed(5)}, {w.longitude.toFixed(5)}
              </span>
            ) : (
              <span className="text-[var(--faint)]">Not resolved from postcode</span>
            )}
          </Field>
        </div>
      </Card>

      <Card title="Contact">
        <div className="space-y-3">
          <Field label="Contact person">{w.contactPerson}</Field>
          <Field label="Email">
            {w.contactEmail ? (
              <a className="text-[var(--accent)] hover:underline" href={`mailto:${w.contactEmail}`}>
                {w.contactEmail}
              </a>
            ) : (
              ""
            )}
          </Field>
          <Field label="Phone">
            {w.contactPhone ? (
              <a className="text-[var(--accent)] hover:underline" href={`tel:${w.contactPhone}`}>
                {w.contactPhone}
              </a>
            ) : (
              ""
            )}
          </Field>
        </div>
      </Card>

      <Card title="Management">
        <div className="space-y-3">
          <Field label="Warehouse manager">
            {w.manager ? (
              <div>
                <div className="font-semibold">
                  {w.manager.name}
                  {w.manager.jobTitle && (
                    <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">
                      · {w.manager.jobTitle}
                    </span>
                  )}
                </div>
                <a className="text-xs text-[var(--accent)] hover:underline" href={`mailto:${w.manager.email}`}>
                  {w.manager.email}
                </a>
              </div>
            ) : (
              <span className="text-[var(--faint)]">No manager assigned</span>
            )}
          </Field>
          {w.description && <Field label="Description">{w.description}</Field>}
        </div>
      </Card>

      <Card title="Operations">
        <div className="space-y-3">
          <Field label="Operating hours">{w.operatingHours}</Field>
          <Field label="Timezone">{w.timezone}</Field>
          <Field label="Notes">{w.notes}</Field>
        </div>
      </Card>

      <Card title="Record">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{w.type?.name ?? "—"}</Field>
          <Field label="Default">{w.isDefault ? "Yes" : "No"}</Field>
          <Field label="Created">{fmtDate(w.createdAt)}</Field>
          <Field label="Updated">{fmtDate(w.updatedAt)}</Field>
          <Field label="Created by">{w.createdBy}</Field>
          <Field label="Updated by">{w.updatedBy}</Field>
        </div>
      </Card>
    </div>
  );
}

// "Incoming stock" tab: a pill toggle between the two RECEIVING flows at this warehouse — company
// goods receipts (GRN, gated by goods_in.view) and customer consignment intake (gated by
// stock_requests.view). Mirrors the Inventory tab's owner toggle; the two pools NEVER co-mingle (each
// pane renders only its own owner's data). The chosen pool lives in ?pool= so it survives a refresh.
function IncomingTab({
  warehouseCode,
  warehouseId,
  router,
  pushToast,
}: {
  warehouseCode: string;
  warehouseId: string;
  router: ReturnType<typeof useRouter>;
  pushToast: (msg: string, type?: "success" | "alert") => void;
}) {
  const { can } = useAuth();
  const searchParams = useSearchParams();
  const canGrn = can("goods_in.view");
  const canCustomer = can("stock_requests.view");

  const requested = searchParams.get("pool");
  const pool: "grn" | "customer" =
    requested === "customer" || requested === "grn" ? requested : canGrn ? "grn" : "customer";
  const active: "grn" | "customer" = canGrn && canCustomer ? pool : canGrn ? "grn" : "customer";

  const setPool = (p: "grn" | "customer") =>
    router.replace(`/dashboard/warehouses/${warehouseCode}?tab=incoming&pool=${p}`, { scroll: false });

  // Within the Company (GRN) pool: "Expected deliveries" (open POs to receive — the WM worklist)
  // vs "Received" (GRN history). Persisted in ?inbound= so a refresh keeps the chosen view.
  // Expected needs PO read access; without it, only Received shows.
  const canExpected = can("purchase_orders.view");
  const inbound: "expected" | "received" =
    !canExpected ? "received" : searchParams.get("inbound") === "received" ? "received" : "expected";
  const setInbound = (v: "expected" | "received") =>
    router.replace(`/dashboard/warehouses/${warehouseCode}?tab=incoming&pool=grn&inbound=${v}`, { scroll: false });

  const showOwnerToggle = canGrn && canCustomer;
  const showViewSwitcher = active === "grn" && canExpected;

  // Slot in the toolbar row that ExpectedDeliveries portals its filter menu into. The filter stays
  // owned by that component (its options and counts are derived from rows only it has loaded); this
  // only lends it a position, so the menu sits in the toolbar's empty middle instead of claiming a
  // second full-width row of its own directly above the table.
  const [filterSlot, setFilterSlot] = React.useState<HTMLDivElement | null>(null);

  return (
    <div className="flex h-full flex-col gap-4">
      {/* One toolbar row: owner toggle (Company/Customer) on the left — matching the Inventory tab —
          the Expected-deliveries filter in the middle, and, only while Company is active, the
          Expected/Received view switcher on the right. */}
      {(showOwnerToggle || showViewSwitcher) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {showOwnerToggle &&
            ([
              { key: "grn", label: "Company (GRN)" },
              { key: "customer", label: "Customer" },
            ] as const).map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => setPool(p.key)}
                className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
                  active === p.key
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                {p.label}
              </button>
            ))}
          {/* Portal target — see filterSlot — grouped with the view switcher so both sit together
              on the right. ml-auto goes on the group, not the slot: on the slot it would claim the
              row's free space and shove the switcher off the edge once the menu appeared. An empty
              slot has no width, so the row looks exactly as it did before. */}
          <div className={`flex items-center gap-2 ${showOwnerToggle ? "ml-auto" : ""}`}>
            <div ref={setFilterSlot} className="flex items-center" />
            {showViewSwitcher && (
              <div className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
                {([
                  { key: "expected", label: "Expected" },
                  { key: "received", label: "Received" },
                ] as const).map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => setInbound(v.key)}
                    className={`rounded-full px-3 py-1 text-[11px] font-bold transition-all ${
                      inbound === v.key
                        ? "bg-[var(--accent)] text-white"
                        : "text-[var(--muted)] hover:text-[var(--ink)]"
                    }`}
                  >
                    {v.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {active === "grn" ? (
          inbound === "expected" ? (
            // key: a different warehouse is a different worklist, so remount rather than reuse.
            // Without it the previous warehouse's rows stay on screen during the refetch (no
            // skeleton, because `rows` isn't null), a stale error pins the error state forever,
            // and the active filter/page carry over to a warehouse where they may match nothing.
            <ExpectedDeliveries key={warehouseId} warehouseId={warehouseId} warehouseCode={warehouseCode} filterSlot={filterSlot} />
          ) : (
            <GoodsReceiptsView warehouseId={warehouseId} warehouseCode={warehouseCode} embedded />
          )
        ) : (
          <IncomingStock warehouseId={warehouseId} pushToast={pushToast} />
        )}
      </div>
    </div>
  );
}

// Matches Expected deliveries' PAGE_SIZE so both Incoming-stock pools page identically.
const INCOMING_PAGE_SIZE = 20;

function IncomingStock({
  warehouseId,
  pushToast,
}: {
  warehouseId: string;
  pushToast: (msg: string, type?: "success" | "alert") => void;
}) {
  const router = useRouter();
  const [items, setItems] = React.useState<PendingStockItem[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [receiveTarget, setReceiveTarget] = React.useState<PendingStockItem | null>(null);
  // Client-side paging, matching the Company (GRN) pool's Expected deliveries: the whole
  // worklist is already loaded in one call, so this only slices what's rendered.
  const [page, setPage] = React.useState(1);

  const load = React.useCallback(() => {
    customerService
      .getPendingStockForWarehouse(warehouseId)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load incoming stock."));
  }, [warehouseId]);

  React.useEffect(() => { load(); }, [load]);

  const onReceived = (updated: WarehouseAssignment, stockEntryId: string) => {
    setReceiveTarget(null);
    pushToast(
      updated.status === "received"
        ? `Fully received at ${updated.warehouseName}.`
        : `Received ${updated.receivedQuantity}/${updated.quantity} at ${updated.warehouseName}.`,
      "success",
    );
    // Jump straight into the just-received draft entry (warehouse context) so the WM can fill the
    // product details, generate the barcode + print the label, and activate — no hunting for it in the
    // Inventory tab. A PARTIAL receipt tops up the SAME entry, so this opens it either way. The
    // Incoming list re-loads when the WM navigates back. Falls back to a refresh if the id is missing.
    if (stockEntryId) {
      router.push(`/dashboard/stock-entries/${stockEntryId}?from=warehouse`);
    } else {
      load();
    }
  };

  const total = items?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / INCOMING_PAGE_SIZE));
  // Clamp rather than store a corrected page: receiving the last row on the last page shrinks the
  // list, and a stale out-of-range `page` would otherwise render an empty table.
  const safePage = Math.min(page, totalPages);
  const pageRows = React.useMemo(
    () => (items ?? []).slice((safePage - 1) * INCOMING_PAGE_SIZE, safePage * INCOMING_PAGE_SIZE),
    [items, safePage],
  );

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (items === null) return <TableSkeleton headers={["Customer", "Item", "Qty", "Received", "Status", "Requested", ""]} minWidth={700} />;
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <Boxes className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No incoming stock</p>
        <p className="text-xs text-[var(--muted)]">Customer stock assigned to this warehouse will appear here.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-sm" style={{ minWidth: 700 }}>
          <thead className="sticky top-0 z-10 bg-[var(--surface)]">
            <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              <th className="px-4 py-3">Customer</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Qty</th>
              <th className="px-4 py-3">Received</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Requested</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((it) => {
              const remaining = it.quantity - it.receivedQuantity;
              return (
                <tr key={it.assignmentId} className="border-b border-[var(--border)] align-top last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-semibold text-[var(--ink)]">{it.customerName}</div>
                    <div className="font-mono text-[11px] text-[var(--faint)]">{it.customerCode}</div>
                  </td>
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{it.itemName}</td>
                  <td className="px-4 py-3 font-bold text-[var(--ink)]">{it.quantity}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {it.receivedQuantity}/{it.quantity}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                        it.status === "partially_received"
                          ? "bg-indigo-500/12 text-indigo-600"
                          : "bg-amber-500/15 text-amber-600"
                      }`}
                    >
                      {it.status.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--muted)]">{fmtDate(it.createdAt)}</td>
                  <td className="px-4 py-3">
                    {remaining > 0 && (
                      <button
                        type="button"
                        onClick={() => setReceiveTarget(it)}
                        className="rounded-lg bg-[var(--pos)] px-2.5 py-1.5 text-[11px] font-bold text-white transition-all hover:opacity-90"
                      >
                        Receive
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>

      <div className="shrink-0">
        <Pagination page={safePage} totalPages={totalPages} total={total} label="items" onPage={setPage} />
      </div>

      {receiveTarget && (
        <ReceiveStockModal
          assignment={{
            id: receiveTarget.assignmentId,
            warehouseId: warehouseId,
            warehouseName: receiveTarget.warehouseName,
            warehouseCode: receiveTarget.warehouseCode,
            quantity: receiveTarget.quantity,
            receivedQuantity: receiveTarget.receivedQuantity,
            status: receiveTarget.status as "pending" | "partially_received" | "received",
            receivedBy: null,
            receivedAt: null,
            notes: null,
          }}
          itemName={receiveTarget.itemName}
          onClose={() => setReceiveTarget(null)}
          onSaved={onReceived}
        />
      )}
    </div>
  );
}

// "Stock" tab: a pill toggle between three stock pools held at this warehouse —
// company IRM inventory (gated by inventory.view), customer consignment stock, and
// the damaged pool (also gated by inventory.view). The chosen pool lives in ?pool=
// so it survives a refresh / is shareable. A user without inventory.view sees only
// the customer pool, with no toggle.
function StockTab({
  warehouseCode,
  warehouseId,
  router,
}: {
  warehouseCode: string;
  warehouseId: string;
  router: ReturnType<typeof useRouter>;
}) {
  const { can } = useAuth();
  const searchParams = useSearchParams();
  const canIrm = can("inventory.view");

  const requested = searchParams.get("pool");
  const pool: "irm" | "customer" | "damaged" =
    requested === "customer" || requested === "irm" || requested === "damaged"
      ? requested
      : canIrm
        ? "irm"
        : "customer";
  const active: "irm" | "customer" | "damaged" = canIrm ? pool : "customer";

  const setPool = (p: "irm" | "customer" | "damaged") =>
    router.replace(`/dashboard/warehouses/${warehouseCode}?tab=inventory&pool=${p}`, { scroll: false });

  const POOL_PILLS = canIrm
    ? ([
        { key: "irm", label: "Company (IRM)" },
        { key: "customer", label: "Customer" },
        { key: "damaged", label: "Damaged" },
      ] as const)
    : ([] as const);

  return (
    <div className="flex h-full flex-col gap-4">
      {canIrm && (
        <div className="flex shrink-0 items-center gap-2">
          {POOL_PILLS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPool(p.key)}
              className={`rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
                active === p.key
                  ? "bg-[var(--accent)] text-white"
                  : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      {active === "irm" ? (
        // Embedded InventoryView manages its own natural height — give it a scrolling box
        // (same contract as InventoryHub's IRM lens).
        <div className="min-h-0 flex-1 overflow-auto">
          <InventoryView warehouseId={warehouseId} embedded />
        </div>
      ) : active === "damaged" ? (
        <div className="min-h-0 flex-1">
          <DamagedStockView warehouseId={warehouseId} fill />
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <WarehouseStockEntries warehouseId={warehouseId} router={router} />
        </div>
      )}
    </div>
  );
}

const STOCK_FILTER_OPTIONS = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "draft", label: "Draft" },
];

const PAGE_SIZE = 20;

function WarehouseStockEntries({
  warehouseId,
  router,
}: {
  warehouseId: string;
  router: ReturnType<typeof useRouter>;
}) {
  const searchParams = useSearchParams();
  const stockFilter = (searchParams.get("stockFilter") ?? "") as "" | "draft" | "active";
  const page = Math.max(1, Number(searchParams.get("stockPage")) || 1);

  const patch = React.useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      params.delete("stockPage");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  const patchPage = React.useCallback(
    (next: number | null) => {
      const params = new URLSearchParams(window.location.search);
      if (next && next > 1) params.set("stockPage", String(next)); else params.delete("stockPage");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );

  const [entries, setEntries] = React.useState<CustomerStockEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    customerService
      .listWarehouseStockEntries(warehouseId, stockFilter || undefined)
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load stock entries."));
  }, [warehouseId, stockFilter]);

  React.useEffect(() => { load(); }, [load]);

  const { visibleEntries, pageSlice, totalPages } = React.useMemo(() => {
    const all = entries ?? [];
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, pages);
    const start = (safePage - 1) * PAGE_SIZE;
    return {
      visibleEntries: all,
      pageSlice: all.slice(start, start + PAGE_SIZE),
      totalPages: pages,
    };
  }, [entries, page]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (entries === null) {
    return <TableSkeleton headers={["Item", "Customer", "SKU", "Qty", "Barcode", "Status", "Received", ""]} minWidth={750} />;
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Status filter */}
      <div className="flex shrink-0 items-center gap-2">
        <Select
          size="sm"
          value={stockFilter}
          onChange={(v) => { patch({ stockFilter: v || null }); }}
          options={STOCK_FILTER_OPTIONS}
          ariaLabel="Filter by status"
        />
      </div>

      {visibleEntries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
          <Boxes className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No stock entries</p>
          <p className="text-xs text-[var(--muted)]">
            {stockFilter ? `No ${stockFilter} entries found.` : "Customer stock received at this warehouse will appear here."}
          </p>
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-sm" style={{ minWidth: 750 }}>
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="px-4 py-3">Item</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">SKU</th>
                  <th className="px-4 py-3">Qty</th>
                  <th className="px-4 py-3">Barcode</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Received</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {pageSlice.map((e) => (
                  <tr
                    key={e.id}
                    className="cursor-pointer border-b border-[var(--border)] align-top transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                    onClick={() => router.push(`/dashboard/stock-entries/${e.id}?from=warehouse`)}
                  >
                    <td className="px-4 py-3 font-semibold text-[var(--ink)]">{e.itemName}</td>
                    <td className="px-4 py-3">
                      <div className="text-[var(--ink)]">{e.customerName}</div>
                      <div className="font-mono text-[11px] text-[var(--faint)]">{e.customerCode}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{e.sku ?? "—"}</td>
                    <td className="px-4 py-3 font-bold text-[var(--ink)]">{e.quantity}</td>
                    <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{e.barcode ?? "—"}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          e.status === "active"
                            ? "bg-[var(--pos)]/12 text-[var(--pos)]"
                            : "bg-amber-500/15 text-amber-600"
                        }`}
                      >
                        {e.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-[var(--muted)]">{fmtDate(e.receivedAt ?? e.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          title="View"
                          onClick={(ev) => { ev.stopPropagation(); router.push(`/dashboard/stock-entries/${e.id}?from=warehouse`); }}
                          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] transition-all hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          title="Edit"
                          onClick={(ev) => { ev.stopPropagation(); router.push(`/dashboard/stock-entries/${e.id}?from=warehouse`); }}
                          className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent)] text-white transition-all hover:opacity-90"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          </div>
          <div className="shrink-0">
            <Pagination
              page={Math.min(page, totalPages)}
              totalPages={totalPages}
              total={visibleEntries.length}
              label="entries"
              onPage={(n) => patchPage(n)}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Placeholder({ icon: Icon, title, body }: { icon: React.ElementType; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] px-6 py-16 text-center">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--accent-10)] text-[var(--accent)]">
        <Icon className="h-5 w-5" />
      </span>
      <p className="text-sm font-bold text-[var(--ink)]">{title}</p>
      <p className="max-w-md text-xs text-[var(--muted)]">{body}</p>
      <span className="mt-1 rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">
        Coming soon
      </span>
    </div>
  );
}

// Warehouse-specific audit history. The API filters by targetType; we narrow to this
// warehouse's id client-side (a single warehouse's history is small).
function AuditTrail({ warehouseId }: { warehouseId: string }) {
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    auditService
      .listAuditLogs({ targetType: "warehouse", pageSize: 100 })
      .then((res) => {
        if (active) setEntries(res.entries.filter((e) => e.targetId === warehouseId));
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load the audit trail.");
      });
    return () => {
      active = false;
    };
  }, [warehouseId]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (entries === null) return <AuditTrailSkeleton />;
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <ScrollText className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No activity yet</p>
        <p className="text-xs text-[var(--muted)]">Changes to this warehouse will be recorded here.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <ul className="divide-y divide-[var(--border)]">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-3">
              <span
                className={`inline-block shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${TONE_CLASSES[actionTone(e.action)]}`}
              >
                {actionLabel(e.action)}
              </span>
              <span className="text-xs text-[var(--muted)]">{e.actorEmail ?? "system"}</span>
            </div>
            <span className="shrink-0 text-[11px] text-[var(--faint)]" title={new Date(e.createdAt).toLocaleString("en-GB")}>
              {relativeTime(e.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
