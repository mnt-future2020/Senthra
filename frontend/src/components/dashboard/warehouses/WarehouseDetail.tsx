"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Boxes, Eye, Loader2, MapPin, Pencil, Power, Printer, ScrollText, Search } from "lucide-react";

import * as warehouseService from "@/services/warehouse.service";
import * as customerService from "@/services/customer.service";
import * as auditService from "@/services/audit.service";
import { Select } from "@/components/ui/Select";
import { Pagination } from "@/components/ui/Pagination";
// toolbar* for the controls inside a filter row (search + Select + Clear, all one height);
// secondaryBtn for the buttons that stand alone — the header action and the empty-state Clears.
import { secondaryBtn, toolbarBtn, toolbarInputCls } from "@/components/ui/styles";
import { searchStockEntries } from "@/lib/stockEntrySearch";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { useAttention } from "@/hooks/useAttention";
import { useEntityAttention } from "@/hooks/useEntityAttention";
import { CountPill } from "@/components/dashboard/shell/TabCount";
import { followQuery, keysForPane, keysForTab } from "./warehouseAttention";
import type { AttentionTone } from "@/services/attention.service";
import { NoStaffAssigned, StaffChip } from "@/components/ui/StaffChip";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Skeleton } from "@/components/ui/Skeleton";
import { actionLabel, actionTone, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { AuditTrailSkeleton } from "@/components/dashboard/audit/AuditTrailSkeleton";
import { MovementFeed, type MovementFetcher } from "@/components/dashboard/inventory/MovementFeed";
import * as stockPositionService from "@/services/stockPosition.service";
import { ReportDamageModal, type ReportDamageTarget } from "@/components/dashboard/goods-management/ReportDamageModal";
import { ReceiveStockModal } from "@/components/dashboard/customers/ReceiveStockModal";
import { CloseShortModal } from "@/components/dashboard/customers/CloseShortModal";
import {
  EMPTY_FILTERS,
  customerFilterOptions,
  effectiveFilters,
  filterPendingStock,
  hasActiveFilter,
  statusFilterOptions,
  type PendingStockFilters,
} from "./incomingStockFilter";
import { InventoryView } from "@/components/dashboard/inventory/InventoryView";
import { GoodsReceiptsView } from "@/components/dashboard/goods-in/GoodsReceiptsView";
import { GoodsManagementTab } from "@/components/dashboard/goods-management/GoodsManagementTab";
import { VanRequestsWorkspace } from "@/components/dashboard/van-requests/VanRequestsWorkspace";
import { DemandTab } from "@/components/dashboard/goods-management/DemandTab";
import { DamagedStockView } from "@/components/dashboard/goods-management/DamagedStockView";
import { ExpectedDeliveries } from "./ExpectedDeliveries";
import { AwaitingHireDeliveries } from "./AwaitingHireDeliveries";
import { WarehouseHireStock } from "./WarehouseHireStock";
import type { PagedAuditLogs } from "@/types/audit";
import type { CustomerStockEntry, PendingStockItem } from "@/types/customer";
import type { Warehouse } from "@/types/warehouse";
import type { UserStatus } from "@/types/user";
import { formatDate as fmtDate } from "@/lib/formatDate";


// First-load placeholder mirroring a data table — keeps the warehouse panes' loading style
// consistent with the GRN list (skeleton rows, not a spinner). Pass the column headers + min width.
function TableSkeleton({ headers, minWidth }: { headers: string[]; minWidth: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" style={{ minWidth }}>
        <thead>
          <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
            {headers.map((h, i) => (<th key={i} className="cell-y px-4">{h}</th>))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: 6 }).map((_, i) => (
            <tr key={i} className="border-b border-[var(--border)] last:border-0">
              {headers.map((_h, j) => (<td key={j} className="cell-y px-4"><Skeleton className="h-3 w-20" /></td>))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
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
// for card-style tabs (overview / audit) that scroll the whole page naturally. Set it
// declaratively per tab rather than string-matching keys in the render, so a new tab can't silently
// clip by being missed off a hardcoded list.
// `attention` lists the catalog keys whose work is done ON that tab. Their counts are what the
// sidebar's Warehouses badge is made of, and — for six of them — the only place the number can be
// acted on: those queues span warehouses, so no cross-warehouse screen exists and the catalog gives
// them no href. Putting the count here is what makes "Job kit to issue · 12" reachable at all.
//
// Which keys belong to which tab (and to which PANE inside it) lives in warehouseAttention.ts, and the
// counts below are derived from it — a tab total written separately from its panes' shares is exactly
// how "Incoming stock 4" came to open a pane holding none of them.
/** critical &lt; attention &lt; info — lower wins, matching the server's own rollup. */
const TONE_RANK: Record<AttentionTone, number> = { critical: 0, attention: 1, info: 2 };

/**
 * One attention key's count at THIS warehouse, handed down to the panes inside a tab.
 *
 * A tab count alone stops one level too high: "Incoming stock 4" tells someone the work is on this
 * tab, but that tab opens on the Company (GRN) pane while the 4 may all be customer intake sitting
 * behind a pill they never pressed. The number has to keep resolving until it reaches the pane that
 * actually lists the rows — so the pills carry it too.
 */
type KeyAttention = (key: string) => { count: number; tone: AttentionTone };

/** Total across a set of keys, taking the most severe tone among the ones that actually have work. */
function sumKeys(keys: string[], keyAttention: KeyAttention): { count: number; tone: AttentionTone } {
  let count = 0;
  let tone: AttentionTone = "info";
  for (const k of keys) {
    const hit = keyAttention(k);
    if (hit.count <= 0) continue;
    count += hit.count;
    if (TONE_RANK[hit.tone] < TONE_RANK[tone]) tone = hit.tone;
  }
  return { count, tone };
}

const TABS: { key: Tab; label: string; perms?: string[]; fill?: boolean }[] = [
  { key: "overview", label: "Overview" },
  { key: "incoming", label: "Incoming stock", perms: ["goods_in.view", "stock_requests.view"], fill: true },
  { key: "inventory", label: "Inventory", fill: true },
  { key: "goods", label: "Goods Management", perms: ["goods_management.view"], fill: true },
  { key: "van", label: "Field Stock Requests", perms: ["van_stock_request.review"], fill: true },
  { key: "demand", label: "Demand", perms: ["inventory.view"], fill: true },
  // `inventory.history` is what the movements endpoint itself requires. Without this gate the tab was
  // visible to anyone who could open a warehouse and returned a 403 the moment they clicked it —
  // advertising a capability they don't have. `fill` because the feed is a full-height inline-scroll
  // layout (its own body scrolls); omitting it gave the tab a second, outer scrollbar.
  { key: "transactions", label: "Transactions", perms: ["inventory.history"], fill: true },
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

  // This warehouse's own share of each queue. Keys the actor may not act on are already absent
  // server-side, so a tab only ever counts work its viewer could actually do.
  const { rows: warehouseAttention } = useEntityAttention("warehouse");
  const mine = warehouseAttention[w.id];
  // Tone per KEY, from the shared catalog payload the sidebar already fetched — so a tab holding only
  // calm work stays calm even when something critical sits on another tab of the same warehouse.
  const { attention } = useAttention();
  const keyAttention: KeyAttention = (key) => ({
    count: mine?.keys[key] ?? 0,
    tone: attention.items.find((i) => i.key === key)?.tone ?? "info",
  });

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
    <div className="stack flex h-full flex-col">
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
            {/* CountPill renders nothing at zero, so a quiet tab looks exactly as it did before. */}
            {(() => {
              const { count, tone } = sumKeys(keysForTab(t.key), keyAttention);
              return <CountPill count={count} tone={tone} label={`awaiting action on ${t.label}`} className="ml-1.5" />;
            })()}
          </button>
        ))}
      </div>

      {/* A `fill` tab owns its own scrolling (full-height inline-scroll layout) → give it a bounded,
          non-scrolling box so only its table body scrolls (sticky headers, pinned pagination).
          Card-style tabs scroll as a whole page. Driven by the tab's declarative `fill` flag. */}
      <div className={`min-h-0 flex-1 ${activeTab?.fill ? "overflow-hidden" : "overflow-auto"}`}>
        {tab === "overview" && <Overview w={w} />}
        {tab === "inventory" && <StockTab warehouseCode={w.code} warehouseId={w.id} router={router} keyAttention={keyAttention} />}
        {tab === "incoming" && <IncomingTab warehouseCode={w.code} warehouseId={w.id} router={router} pushToast={pushToast} keyAttention={keyAttention} />}
        {tab === "goods" && <GoodsManagementTab warehouseId={w.id} router={router} />}
        {tab === "van" && <VanRequestsWorkspace warehouse={{ id: w.id, name: w.name, code: w.code }} />}
        {tab === "demand" && <DemandTab warehouseId={w.id} />}
        {tab === "transactions" && <WarehouseTransactions warehouseId={w.id} />}
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
    // min-w-0 lets this grid cell shrink below its content (grid items default to min-width:auto,
    // so a long unbroken value refuses to shrink and spills into the neighbouring column);
    // wrap-break-word then lets that value actually break. Emails are the usual culprit.
    <div className="min-w-0">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <div className="mt-0.5 text-sm wrap-break-word text-[var(--ink)]">{children || "—"}</div>
    </div>
  );
}

function Overview({ w }: { w: Warehouse }) {
  const { can } = useAuth();
  const canViewUsers = can("users.view");
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
          {/* DERIVED, read-only: the staff assigned this warehouse under Users & Roles. There is no
              manager field on a warehouse — the assignment that grants access IS the assignment. */}
          <Field
            label={w.managers.length > 1 ? `Warehouse managers (${w.managers.length})` : "Warehouse manager"}
          >
            {w.managers.length ? (
              <div className="mt-2 space-y-3">
                {w.managers.map((m) => (
                  <StaffChip
                    key={m.id}
                    staff={m}
                    href={canViewUsers ? `/dashboard/users/${m.id}` : undefined}
                  />
                ))}
              </div>
            ) : (
              <NoStaffAssigned label="No manager assigned" />
            )}
          </Field>
          <Field label="Description">{w.description}</Field>
          {/* Card footer — always shown, otherwise there's no clue this is set somewhere else. */}
          <p className="border-t border-[var(--border)] pt-3 text-[11px] text-[var(--faint)]">
            Managers are the staff assigned this warehouse under Users &amp; Roles.
          </p>
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
  keyAttention,
}: {
  warehouseCode: string;
  warehouseId: string;
  router: ReturnType<typeof useRouter>;
  pushToast: (msg: string, type?: "success" | "alert") => void;
  keyAttention: KeyAttention;
}) {
  const { can } = useAuth();
  const searchParams = useSearchParams();
  const canGrn = can("goods_in.view");
  const canCustomer = can("stock_requests.view");
  // Hire deliveries are a THIRD receiving flow at this warehouse, not a third kind of stock. Its own
  // pane because a goods receipt ends in an inventory balance and hired kit never becomes our stock —
  // one pill for both would be the first step towards a GRN for equipment we do not own.
  const canRental = can("rentals.view");

  const requested = searchParams.get("pool");
  const POOLS = ["grn", "customer", "rental"] as const;
  type Pool = (typeof POOLS)[number];
  const allowed: Record<Pool, boolean> = { grn: canGrn, customer: canCustomer, rental: canRental };
  const firstAllowed: Pool = (POOLS.find((k) => allowed[k]) ?? "grn") as Pool;
  const pool: Pool = POOLS.includes(requested as Pool) ? (requested as Pool) : firstAllowed;
  // A pool the viewer cannot see falls back to the first they can, so a shared link never lands
  // somebody on an empty pane they have no permission to fill.
  const active: Pool = allowed[pool] ? pool : firstAllowed;

  // Clicking a pane control that is SHOWING A COUNT lands on that queue's rows, not merely on the
  // list they live in — GRN history holds every completed receipt too, so "Received 3" opening all of
  // them is the same broken promise as a link that filters nothing. With nothing outstanding it
  // navigates plainly, so an empty queue never applies a filter that hides the history.
  const go = (query: string) =>
    router.replace(`/dashboard/warehouses/${warehouseCode}?${query}`, { scroll: false });
  const setPool = (p: Pool) =>
    go(followQuery(keysForPane("incoming", p), (k) => keyAttention(k).count) ?? `tab=incoming&pool=${p}`);

  // Within the Company (GRN) pool: "Expected" (open POs to receive — the WM worklist) vs "Receipts"
  // (the GRN records themselves). Persisted in ?inbound= so a refresh keeps the chosen view.
  // Expected needs PO read access; without it, only Receipts shows.
  //
  // The second view was LABELLED "Received", which was wrong as soon as it carried a count: a GRN is
  // draft | completed | cancelled, and a DRAFT is stock that has physically turned up but has not been
  // booked in — unfinished work, the opposite of "received". So the pane read "Received 1" while the
  // one row in it was a job still to do. The ?inbound= VALUE stays `received` so existing links and
  // the pane map keep working; only the word the user reads changed.
  const canExpected = can("purchase_orders.view");
  const inbound: "expected" | "received" =
    !canExpected ? "received" : searchParams.get("inbound") === "received" ? "received" : "expected";
  const setInbound = (v: "expected" | "received") =>
    go(followQuery(keysForPane("incoming", "grn", v), (k) => keyAttention(k).count) ?? `tab=incoming&pool=grn&inbound=${v}`);

  // Shown as soon as there is more than one pane to choose between.
  const showOwnerToggle = [canGrn, canCustomer, canRental].filter(Boolean).length > 1;
  const showViewSwitcher = active === "grn" && canExpected;

  // Slot in the toolbar row that ExpectedDeliveries portals its filter menu into. The filter stays
  // owned by that component (its options and counts are derived from rows only it has loaded); this
  // only lends it a position, so the menu sits in the toolbar's empty middle instead of claiming a
  // second full-width row of its own directly above the table.
  const [filterSlot, setFilterSlot] = React.useState<HTMLDivElement | null>(null);

  return (
    <div className="stack flex h-full flex-col">
      {/* One toolbar row: owner toggle (Company/Customer) on the left — matching the Inventory tab —
          the Expected-deliveries filter in the middle, and, only while Company is active, the
          Expected/Received view switcher on the right. */}
      {(showOwnerToggle || showViewSwitcher) && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {/* Each pill carries its OWN share of the tab's count, so "Incoming stock 4" resolves to the
              pane holding those 4 instead of stopping at the tab. Which keys those are comes from the
              same map the tab total is derived from, so the parts always add up to the whole. */}
          {showOwnerToggle &&
            ([
              { key: "grn", label: "Company (GRN)" },
              { key: "customer", label: "Customer" },
              // "Rental deliveries", not "Rental": the word that matters is what is happening, because
              // this pane is not another pool of stock — the kit stays the supplier's.
              { key: "rental", label: "Rental deliveries" },
            ] as const)
              .filter((p) => allowed[p.key])
              .map((p) => {
              const hit = sumKeys(keysForPane("incoming", p.key), keyAttention);
              return (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setPool(p.key)}
                  className={`inline-flex items-center rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
                    active === p.key
                      ? "bg-[var(--accent)] text-white"
                      : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
                  }`}
                >
                  {p.label}
                  {/* On the selected pill the tone colours would sit on the accent fill and read as a
                      separate control; a plain inherited-colour number is enough there. */}
                  {active === p.key ? (
                    hit.count > 0 ? <span className="ml-1.5 tabular-nums opacity-80">{hit.count}</span> : null
                  ) : (
                    <CountPill count={hit.count} tone={hit.tone} label={`awaiting action in ${p.label}`} className="ml-1.5" />
                  )}
                </button>
              );
            })}
          {/* Portal target — see filterSlot — grouped with the view switcher so both sit together
              on the right. ml-auto goes on the group, not the slot: on the slot it would claim the
              row's free space and shove the switcher off the edge once the menu appeared. An empty
              slot has no width, so the row looks exactly as it did before. */}
          <div className={`flex items-center gap-2 ${showOwnerToggle ? "ml-auto" : ""}`}>
            <div ref={setFilterSlot} className="flex items-center" />
            {showViewSwitcher && (
              <div className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-2)] p-0.5">
                {/* Draft receipts are GRN records, so the count belongs on Receipts — the pane the
                    tab does NOT open on. Without it the Company pill says 2 and the Expected list it
                    lands on shows none of them. */}
                {([
                  { key: "expected", label: "Expected", hint: "Open purchase orders still to be booked in" },
                  { key: "received", label: "Receipts", hint: "Goods receipts raised here — including drafts still to be completed" },
                ] as const).map((v) => {
                  const hit = sumKeys(keysForPane("incoming", "grn", v.key), keyAttention);
                  return (
                    <button
                      key={v.key}
                      type="button"
                      title={v.hint}
                      onClick={() => setInbound(v.key)}
                      className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-bold transition-all ${
                        inbound === v.key
                          ? "bg-[var(--accent)] text-white"
                          : "text-[var(--muted)] hover:text-[var(--ink)]"
                      }`}
                    >
                      {v.label}
                      {/* Says WHAT the number is, not just how many — a bare count beside a view name
                          reads as "this many items in here", which for a receipts list is wrong. */}
                      {inbound !== v.key ? (
                        <CountPill count={hit.count} tone={hit.tone} label="drafts still to complete" className="ml-1.5" />
                      ) : hit.count > 0 ? (
                        <span className="ml-1.5 tabular-nums opacity-80">{hit.count}</span>
                      ) : null}
                    </button>
                  );
                })}
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
        ) : active === "customer" ? (
          <IncomingStock warehouseId={warehouseId} pushToast={pushToast} />
        ) : (
          // key: a different warehouse is a different queue, so remount rather than leave the previous
          // warehouse's rows on screen through the refetch.
          <AwaitingHireDeliveries key={warehouseId} warehouseId={warehouseId} />
        )}
      </div>
    </div>
  );
}

// Matches Expected deliveries' PAGE_SIZE so both Incoming-stock pools page identically.
const INCOMING_PAGE_SIZE = 20;
// Matches the audit page size every other detail page uses (SupplierDetail, IrmItemDetail, …).
const AUDIT_PAGE_SIZE = 20;

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
  const [closeTarget, setCloseTarget] = React.useState<PendingStockItem | null>(null);
  // The last top-up onto an ALREADY-ACTIVE entry, so the label shortcut below can point at it.
  // Only ever set when we deliberately DIDN'T navigate — a draft receipt lands on the entry page,
  // where the printer already is.
  const [lastTopUp, setLastTopUp] = React.useState<{ entryId: string; itemName: string; quantity: number } | null>(null);
  // Client-side paging AND filtering, matching the Company (GRN) pool's Expected deliveries: the
  // whole worklist is already loaded in one call, so this only slices what's rendered.
  const [page, setPage] = React.useState(1);
  const [filters, setFilters] = React.useState<PendingStockFilters>(EMPTY_FILTERS);

  // Any filter change restarts at page 1. Without it, filtering while on page 3 leaves you staring
  // at a blank slice of a now-shorter list (the clamp below would rescue it, but only after a
  // confusing frame — and landing mid-list is wrong anyway).
  const patchFilters = (next: Partial<PendingStockFilters>) => {
    setFilters((prev) => ({ ...prev, ...next }));
    setPage(1);
  };

  const load = React.useCallback(() => {
    customerService
      .getPendingStockForWarehouse(warehouseId)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load incoming stock."));
  }, [warehouseId]);

  React.useEffect(() => { load(); }, [load]);

  const onReceived = ({ assignment: updated, stockEntryId, stockEntryStatus }: customerService.ReceiveStockResult) => {
    // Captured before the modal closes — the receipt's OWN quantity is the running total minus what
    // had already been booked, and that (not the entry's lifetime total) is how many stickers the
    // units on the loading bay need.
    const justReceived = Math.max(0, updated.receivedQuantity - (receiveTarget?.receivedQuantity ?? 0));
    const itemName = receiveTarget?.itemName ?? "";
    setReceiveTarget(null);
    pushToast(
      updated.status === "received"
        ? `Fully received at ${updated.warehouseName}.`
        : `Received ${updated.receivedQuantity}/${updated.quantity} at ${updated.warehouseName}.`,
      "success",
    );
    // Jump into the entry ONLY while it's still a draft, so the WM can fill the product details,
    // generate the barcode + print the label, and activate — no hunting for it in the Inventory tab.
    //
    // A partial receipt tops up the SAME entry, so once that entry is active every later receipt used
    // to re-open a form the WM had already completed and dropped them out of the Incoming list they
    // were working through. Nothing on that page is actionable for an active entry (quantity is
    // read-only, "Set during receive"), so it was pure detour. Active entries now stay put and the
    // list reloads, which is also what happens when the id is missing.
    if (stockEntryId && stockEntryStatus === "draft") {
      router.push(`/dashboard/stock-entries/${stockEntryId}?from=warehouse`);
    } else {
      // Staying put keeps the queue in front of the manager, but the units that just arrived still
      // need stickers and the entry page is where the printer lives. Nothing on THIS row links
      // there (a pending assignment carries no entry id until it's received), so surface the one we
      // were just handed, pre-loading the copy count with this receipt's quantity.
      if (stockEntryId) setLastTopUp({ entryId: stockEntryId, itemName, quantity: justReceived });
      load();
    }
  };

  const allRows = React.useMemo(() => items ?? [], [items]);
  // Menu options come from the UNFILTERED worklist, so the counts don't shuffle as you narrow down
  // and a customer never disappears from the menu just because the search hid their rows.
  const customerOptions = React.useMemo(() => customerFilterOptions(allRows), [allRows]);
  const statusOptions = React.useMemo(() => statusFilterOptions(allRows), [allRows]);
  // Receiving a customer's last row deletes their option out from under the stored pick. Resolve
  // what's actually in effect so the table and the menus agree — see effectiveFilters.
  const effective = React.useMemo(
    () => effectiveFilters(filters, customerOptions, statusOptions),
    [filters, customerOptions, statusOptions],
  );
  const rows = React.useMemo(() => filterPendingStock(allRows, effective), [allRows, effective]);
  const filtered = hasActiveFilter(effective);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / INCOMING_PAGE_SIZE));
  // Clamp rather than store a corrected page: receiving the last row on the last page shrinks the
  // list, and a stale out-of-range `page` would otherwise render an empty table.
  const safePage = Math.min(page, totalPages);
  const pageRows = React.useMemo(
    () => rows.slice((safePage - 1) * INCOMING_PAGE_SIZE, safePage * INCOMING_PAGE_SIZE),
    [rows, safePage],
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
      {/* Label shortcut for the receipt just booked. Dismissible, and replaced by the next receipt —
          it's a prompt for the stock currently on the bay, not a log. `copies` is carried so the
          entry page opens ready to print exactly what arrived. */}
      {lastTopUp && (
        <div className="flex flex-col gap-3 rounded-xl border border-[var(--pos)]/30 bg-[var(--pos)]/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs leading-relaxed text-[var(--ink)]">
            <span className="font-bold">Received {lastTopUp.quantity} × {lastTopUp.itemName}.</span>{" "}
            Print labels for them if the stock isn&apos;t tagged yet.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() =>
                router.push(`/dashboard/stock-entries/${lastTopUp.entryId}?from=warehouse&copies=${lastTopUp.quantity}`)
              }
              className={secondaryBtn}
            >
              <Printer className="h-3.5 w-3.5" />
              Print labels
            </button>
            <button
              type="button"
              onClick={() => setLastTopUp(null)}
              aria-label="Dismiss"
              className="rounded-lg px-2 py-1 text-xs font-bold text-[var(--muted)] hover:text-[var(--ink)]"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Toolbar. Rendered only once there IS data — an empty warehouse gets the empty state alone,
          not controls with nothing to control. Search covers item + customer name + code; the two
          menus narrow by customer and by how far along the receipt is. */}
      <div className="flex shrink-0 flex-col gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={filters.search}
            onChange={(e) => patchFilters({ search: e.target.value })}
            placeholder="Search item or customer…"
            aria-label="Search incoming customer stock"
            className={`${toolbarInputCls} pl-9`}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          {/* `effective`, not `filters` — a pick whose option has gone shows as "All" rather than
              leaving the trigger blank while the table quietly ignores it. */}
          <Select
            value={effective.customerCode}
            onChange={(v) => patchFilters({ customerCode: v })}
            options={customerOptions}
            ariaLabel="Filter by customer"
            size="sm"
          />
          <Select
            value={effective.status}
            onChange={(v) => patchFilters({ status: v })}
            options={statusOptions}
            ariaLabel="Filter by status"
            size="sm"
          />
          {filtered && (
            <button type="button" onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); }} className={toolbarBtn}>
              Clear
            </button>
          )}
        </div>
      </div>

      {rows.length === 0 ? (
        // Distinct from "No incoming stock": there IS work here, the filters just hide it. Saying
        // otherwise reads as "this warehouse is clear" and sends the WM away.
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
          <Search className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No matching stock</p>
          <p className="text-xs text-[var(--muted)]">
            {allRows.length} incoming item{allRows.length === 1 ? "" : "s"} here, none match these filters.
          </p>
          <button type="button" onClick={() => { setFilters(EMPTY_FILTERS); setPage(1); }} className={`${secondaryBtn} mt-1`}>
            Clear filters
          </button>
        </div>
      ) : (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-sm" style={{ minWidth: 700 }}>
          <thead className="sticky top-0 z-10 bg-[var(--surface)]">
            <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              <th className="cell-y px-4">Customer</th>
              <th className="cell-y px-4">Item</th>
              <th className="cell-y px-4">Qty</th>
              <th className="cell-y px-4">Received</th>
              <th className="cell-y px-4">Status</th>
              <th className="cell-y px-4">Requested</th>
              <th className="cell-y px-4" />
            </tr>
          </thead>
          <tbody>
            {pageRows.map((it) => {
              const remaining = it.quantity - it.receivedQuantity;
              return (
                <tr key={it.assignmentId} className="border-b border-[var(--border)] align-top last:border-0">
                  <td className="cell-y px-4">
                    <div className="font-semibold text-[var(--ink)]">{it.customerName}</div>
                    <div className="font-mono text-[11px] text-[var(--faint)]">{it.customerCode}</div>
                  </td>
                  <td className="cell-y px-4 font-semibold text-[var(--ink)]">{it.itemName}</td>
                  <td className="cell-y px-4 font-bold text-[var(--ink)]">{it.quantity}</td>
                  <td className="cell-y px-4 text-[var(--muted)]">
                    {it.receivedQuantity}/{it.quantity}
                  </td>
                  <td className="cell-y px-4">
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
                  <td className="cell-y px-4 text-xs text-[var(--muted)]">{fmtDate(it.createdAt)}</td>
                  <td className="cell-y px-4">
                    {remaining > 0 && (
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setReceiveTarget(it)}
                          className="rounded-lg bg-[var(--pos)] px-2.5 py-1.5 text-[11px] font-bold text-white transition-all hover:opacity-90"
                        >
                          Receive
                        </button>
                        {/* The way a delivery that will never complete leaves this queue. Secondary
                            to Receive — closing short is the exception, receiving is the job. */}
                        <button
                          type="button"
                          onClick={() => setCloseTarget(it)}
                          title={`Close short — ${remaining} of ${it.quantity} not received`}
                          className="rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[11px] font-bold text-[var(--muted)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)]"
                        >
                          Close short
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        {rows.length > 0 && (
          <Pagination embedded page={safePage} totalPages={totalPages} total={total} label="items" onPage={setPage} />
        )}
      </div>
      )}

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
            // A row in this queue is by definition open, so it carries no closure — the modal only
            // reads quantity/received anyway.
            closureReason: null,
            closedAt: null,
            closedBy: null,
          }}
          itemName={receiveTarget.itemName}
          onClose={() => setReceiveTarget(null)}
          onSaved={onReceived}
        />
      )}

      {closeTarget && (
        <CloseShortModal
          assignment={{
            id: closeTarget.assignmentId,
            warehouseId: warehouseId,
            warehouseName: closeTarget.warehouseName,
            warehouseCode: closeTarget.warehouseCode,
            quantity: closeTarget.quantity,
            receivedQuantity: closeTarget.receivedQuantity,
            status: closeTarget.status as "pending" | "partially_received" | "received" | "closed_short",
            receivedBy: null,
            receivedAt: null,
            notes: null,
            closureReason: null,
            closedAt: null,
            closedBy: null,
          }}
          itemName={closeTarget.itemName}
          onClose={() => setCloseTarget(null)}
          onClosed={(updated, outstanding) => {
            const name = closeTarget.itemName;
            setCloseTarget(null);
            // BOTH figures come from `updated` — the row as the server left it — not from
            // `closeTarget`, which is whatever the queue held when the modal opened. A receive
            // landing in between doesn't block the close, it just moves receivedQuantity, and
            // quoting the stale pair here would tell the user more was missing than really was.
            // "not received", not "written off" — nothing left a ledger; see the note in
            // CloseShortModal on why that word is reserved for the goods-management action. And
            // "not received" rather than any of "short"/"never arrived"/"missing": it's the one
            // phrase used for this quantity everywhere, including the customer's own portal, so a
            // call about this delivery has both sides reading the same words.
            pushToast(
              `Closed short — ${outstanding} of ${updated.quantity} recorded as not received for "${name}".`,
              "success",
            );
            // The row leaves the queue entirely (it reads only the open statuses), so a reload is
            // the whole update — there is nothing left to keep in view.
            load();
          }}
        />
      )}
    </div>
  );
}

// "Stock" tab: a pill toggle between the pools of equipment held at this warehouse —
// company IRM inventory (gated by inventory.view), customer consignment stock, the
// damaged pool (also inventory.view) and hired-in equipment (rentals.view). The chosen
// pool lives in ?pool= so it survives a refresh / is shareable. A user without
// inventory.view sees only the pools their own permissions reach.
//
// "Rental" sits with them because the QUESTION is the same — what is at my site, and what do I owe
// somebody for it — and the roles that answer it are warehouse-scoped. What it deliberately does not
// share is the plumbing: hired kit has no inventory balance, no stock movement and no valuation, and
// the pane reads the hire lines directly. One pill next to three does not make it a fourth pool of
// stock, and the backend fails its build if the two are ever wired together.
function StockTab({
  warehouseCode,
  warehouseId,
  router,
  keyAttention,
}: {
  warehouseCode: string;
  warehouseId: string;
  router: ReturnType<typeof useRouter>;
  keyAttention: KeyAttention;
}) {
  const { can } = useAuth();
  const searchParams = useSearchParams();
  const canIrm = can("inventory.view");
  const canRental = can("rentals.view");

  const POOLS = ["irm", "customer", "damaged", "rental"] as const;
  type Pool = (typeof POOLS)[number];
  // What this viewer may open. Customer stock has no separate gate — the tab itself is the gate.
  const allowed: Record<Pool, boolean> = { irm: canIrm, customer: true, damaged: canIrm, rental: canRental };
  const firstAllowed: Pool = (POOLS.find((k) => allowed[k]) ?? "customer") as Pool;

  const requested = searchParams.get("pool");
  const pool: Pool = POOLS.includes(requested as Pool) ? (requested as Pool) : firstAllowed;
  // A pool the viewer cannot see falls back to the first they can, so a shared link never lands on an
  // empty pane behind a pill they never pressed — the Incoming tab's own rule.
  const active: Pool = allowed[pool] ? pool : firstAllowed;

  // Same rule as the Incoming tab's pills — see the note on `go` there. The customer pool holds both
  // draft and active entries, so "Customer 2" without the filter opens the whole consignment list.
  const setPool = (p: Pool) =>
    router.replace(
      `/dashboard/warehouses/${warehouseCode}?${
        followQuery(keysForPane("inventory", p), (k) => keyAttention(k).count) ?? `tab=inventory&pool=${p}`
      }`,
      { scroll: false },
    );

  // "Received stock to catalogue" is customer-pool work, and this tab opens on Company (IRM) — so
  // without the count on the pill the Inventory tab's number points at a pane nobody opens.
  const ALL_PILLS = [
    { key: "irm", label: "Company (IRM)" },
    { key: "customer", label: "Customer" },
    { key: "damaged", label: "Damaged" },
    { key: "rental", label: "Rental (hired in)" },
  ] as const;
  // Only shown once there is a CHOICE — a single pill is a label pretending to be a control.
  const POOL_PILLS = POOLS.filter((k) => allowed[k]).length > 1 ? ALL_PILLS.filter((p) => allowed[p.key]) : [];

  return (
    <div className="stack flex h-full flex-col">
      {POOL_PILLS.length > 0 && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {POOL_PILLS.map((p) => {
            const hit = sumKeys(keysForPane("inventory", p.key), keyAttention);
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setPool(p.key)}
                className={`inline-flex items-center rounded-full px-3 py-1.5 text-[11px] font-bold transition-all ${
                  active === p.key
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--border)] bg-[var(--surface-2)] text-[var(--muted)] hover:text-[var(--ink)]"
                }`}
              >
                {p.label}
                {active !== p.key ? (
                  <CountPill count={hit.count} tone={hit.tone} label={`awaiting action in ${p.label}`} className="ml-1.5" />
                ) : hit.count > 0 ? (
                  <span className="ml-1.5 tabular-nums opacity-80">{hit.count}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      {active === "irm" ? (
        // Bounded, non-scrolling box: InventoryView scrolls its own table body and keeps its filter
        // row fixed (same contract as the other pools here). Scrolling it from the outside would
        // carry the search and filters off-screen with the rows.
        <div className="min-h-0 flex-1">
          <InventoryView warehouseId={warehouseId} embedded />
        </div>
      ) : active === "damaged" ? (
        <div className="min-h-0 flex-1">
          {/* The hire pool is one pill away, and this pane is where somebody looks first for a broken
              tester an engineer brought back. Pointing at it costs nothing and stops an empty owned-
              stock pool reading as "nothing is damaged here". */}
          <DamagedStockView warehouseId={warehouseId} fill hiredEquipmentHref={`?tab=inventory&pool=rental`} />
        </div>
      ) : active === "rental" ? (
        // Keyed on the warehouse for the same reason the receiving pane is: the rows, error and page
        // inside are per-warehouse, and remounting is how they reset.
        <div className="min-h-0 flex-1">
          <WarehouseHireStock key={warehouseId} warehouseId={warehouseId} />
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
  // Text search lives in the URL like the status filter, so a filtered view is shareable and
  // survives a refresh. Matched in memory — the list arrives in one call (see `load`).
  const stockSearch = searchParams.get("stockSearch") ?? "";
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
  // "Report damage" on customer-owned stock. Same permission as the company pool — `inventory.adjust`
  // already means "may reduce stock in this warehouse", which is exactly what a damage report does.
  const { can } = useAuth();
  const canReportDamage = can("inventory.adjust");
  const [damageTarget, setDamageTarget] = React.useState<ReportDamageTarget | null>(null);

  const load = React.useCallback(() => {
    customerService
      .listWarehouseStockEntries(warehouseId, stockFilter || undefined)
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load stock entries."));
  }, [warehouseId, stockFilter]);

  React.useEffect(() => { load(); }, [load]);

  const { visibleEntries, pageSlice, totalPages } = React.useMemo(() => {
    const all = searchStockEntries(entries ?? [], stockSearch);
    const total = all.length;
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, pages);
    const start = (safePage - 1) * PAGE_SIZE;
    return {
      visibleEntries: all,
      pageSlice: all.slice(start, start + PAGE_SIZE),
      totalPages: pages,
    };
  }, [entries, page, stockSearch]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (entries === null) {
    return <TableSkeleton headers={["Item", "Customer", "SKU", "Qty", "Barcode", "Status", "Received", ""]} minWidth={750} />;
  }

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Search + status filter */}
      <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative w-full sm:max-w-xs">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-[var(--faint)]" />
          <input
            value={stockSearch}
            onChange={(e) => patch({ stockSearch: e.target.value || null })}
            placeholder="Search item, SKU, barcode…"
            aria-label="Search customer stock entries"
            className={`${toolbarInputCls} pl-9`}
          />
        </div>
        <div className="sm:ml-auto">
          <Select
            size="sm"
            value={stockFilter}
            onChange={(v) => { patch({ stockFilter: v || null }); }}
            options={STOCK_FILTER_OPTIONS}
            ariaLabel="Filter by status"
          />
        </div>
      </div>

      {visibleEntries.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
          <Boxes className="h-7 w-7 text-[var(--faint)]" />
          <p className="text-sm font-semibold text-[var(--ink)]">No stock entries</p>
          {/* Distinguish "nothing here" from "your filters hide it" — otherwise a search that
              misses reads as an empty warehouse. */}
          <p className="text-xs text-[var(--muted)]">
            {stockSearch.trim()
              ? `Nothing matches “${stockSearch.trim()}”${stockFilter ? ` in ${stockFilter} entries` : ""}.`
              : stockFilter
                ? `No ${stockFilter} entries found.`
                : "Customer stock received at this warehouse will appear here."}
          </p>
          {(stockSearch.trim() || stockFilter) && (
            <button
              type="button"
              onClick={() => patch({ stockSearch: null, stockFilter: null })}
              className={`${secondaryBtn} mt-1`}
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
            <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full text-left text-sm" style={{ minWidth: 750 }}>
              <thead className="sticky top-0 z-10 bg-[var(--surface)]">
                <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                  <th className="cell-y px-4">Item</th>
                  <th className="cell-y px-4">Customer</th>
                  <th className="cell-y px-4">SKU</th>
                  <th className="cell-y px-4">Qty</th>
                  <th className="cell-y px-4">Barcode</th>
                  <th className="cell-y px-4">Status</th>
                  <th className="cell-y px-4">Received</th>
                  <th className="cell-y px-4" />
                </tr>
              </thead>
              <tbody>
                {pageSlice.map((e) => (
                  <tr
                    key={e.id}
                    className="cursor-pointer border-b border-[var(--border)] align-top transition-colors last:border-0 hover:bg-[var(--surface-2)]"
                    onClick={() => router.push(`/dashboard/stock-entries/${e.id}?from=warehouse`)}
                  >
                    <td className="cell-y px-4 font-semibold text-[var(--ink)]">{e.itemName}</td>
                    <td className="cell-y px-4">
                      <div className="text-[var(--ink)]">{e.customerName}</div>
                      <div className="font-mono text-[11px] text-[var(--faint)]">{e.customerCode}</div>
                    </td>
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{e.sku ?? "—"}</td>
                    <td className="cell-y px-4 font-bold text-[var(--ink)]">{e.quantity}</td>
                    <td className="cell-y px-4 font-mono text-xs text-[var(--muted)]">{e.barcode ?? "—"}</td>
                    <td className="cell-y px-4">
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
                    <td className="cell-y px-4 text-xs text-[var(--muted)]">{fmtDate(e.receivedAt ?? e.createdAt)}</td>
                    <td className="cell-y px-4">
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
                        {/* Report damage on the CUSTOMER'S stock sitting in our racking. This is the
                            liability case — it's their property in our warehouse — so the photo the
                            modal demands is the evidence any dispute would turn on. Disabled at zero
                            qty (nothing to damage) and on a draft entry (not yet received). */}
                        {canReportDamage && (
                          <button
                            type="button"
                            title="Report damage"
                            disabled={e.quantity <= 0 || e.status !== "active"}
                            onClick={(ev) => {
                              ev.stopPropagation();
                              setDamageTarget({
                                warehouseId,
                                ownerType: "customer",
                                irmItemId: null,
                                customerStockEntryId: e.id,
                                itemName: e.itemName,
                                available: e.quantity,
                              });
                            }}
                            className="flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--surface-2)] text-[var(--ink)] transition-all hover:border-[var(--neg)] hover:text-[var(--neg)] disabled:opacity-40"
                          >
                            <AlertTriangle className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <Pagination embedded
              page={Math.min(page, totalPages)}
              totalPages={totalPages}
              total={visibleEntries.length}
              label="entries"
              onPage={(n) => patchPage(n)}
            />
          </div>
        </>
      )}

      <ReportDamageModal
        target={damageTarget}
        onClose={() => setDamageTarget(null)}
        // The entry's quantity dropped, so refetch this list. No cache to clear here — the customer
        // stock list is fetched fresh on every load (unlike the IRM pool's SWR cache).
        onReported={load}
      />
    </div>
  );
}

// This warehouse's stock movement history — the shared MovementFeed, pinned to this warehouse.
//
// It replaced a "Coming soon" placeholder that read "…once inventory movements are live". Movements
// HAVE been live for some time (the Inventory Hub's Movements tab, the engineer feed and the IRM item
// history all render this same component) and the ledger already accepted a warehouse filter — this
// tab was simply never wired up. Nothing needed building; it needed connecting.
// Module-level, not inline: a fetcher recreated on every render is a new function identity, which
// would retrigger the feed's load effect on each parent re-render.
const movementFetcher: MovementFetcher = (params) => stockPositionService.listMovements(params);

function WarehouseTransactions({ warehouseId }: { warehouseId: string }) {
  return (
    <div className="flex h-full flex-col gap-3">
      {/* States the scope precisely, because the ledger's warehouse filter narrows to the company
          (IRM) pool plus damaged. Customer consignment stock at this warehouse has no per-movement
          ledger — its balances move correctly but only the damaged leg produces a row — so a reader
          comparing the two legs of a damage report would otherwise think the feed had lost one. Same
          caveat the Inventory Hub's Movements tab carries, worded for one warehouse. No promise about
          what might change. */}
      <p className="shrink-0 text-xs text-[var(--muted)]">
        Goods in, transfers and adjustments for this warehouse. Newest first.{" "}
        <span className="text-[var(--faint)]">Customer consignment shows the damaged leg only.</span>
      </p>
      <div className="min-h-0 flex-1">
        <MovementFeed fetcher={movementFetcher} scope="admin" lockedWarehouse={warehouseId} />
      </div>
    </div>
  );
}

// Warehouse-specific audit history. The API filters by targetType; we narrow to this
// warehouse's id client-side (a single warehouse's history is small).
// This used to ask for the newest 100 events of targetType "warehouse" ACROSS EVERY WAREHOUSE and
// then keep the ones matching this id in the browser. With more than a handful of active warehouses
// that window rarely contained many of this one's events — and on a busy estate it could contain
// none at all, so the tab read "No activity yet" for a warehouse with a full history. Worse, there
// was no way to page further back, so the missing events were simply unreachable.
//
// Scoped server-side by targetId and paginated, matching every other detail page's audit tab
// (SupplierDetail, IrmItemDetail, GoodsReceiptDetail, PurchaseRequestDetail). The page lives in
// ?auditPage= so it survives a refresh and doesn't collide with the other tabs' params.
function AuditTrail({ warehouseId }: { warehouseId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const page = Math.max(1, Number(searchParams.get("auditPage")) || 1);
  const patchPage = React.useCallback(
    (next: number | null) => {
      const params = new URLSearchParams(window.location.search);
      if (next && next > 1) params.set("auditPage", String(next)); else params.delete("auditPage");
      router.replace(`${window.location.pathname}?${params.toString()}`, { scroll: false });
    },
    [router],
  );
  const [result, setResult] = React.useState<PagedAuditLogs | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const controller = new AbortController();
    auditService
      .listAuditLogs({ targetType: "warehouse", targetId: warehouseId, page, pageSize: AUDIT_PAGE_SIZE })
      .then((res) => {
        if (controller.signal.aborted) return;
        setError(null); // a later page succeeding must clear an earlier page's failure
        setResult(res);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load the audit trail.");
      });
    return () => {
      controller.abort();
      setResult(null);
    };
  }, [warehouseId, page]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (result === null) return <AuditTrailSkeleton />;
  if (result.total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <ScrollText className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No activity yet</p>
        <p className="text-xs text-[var(--muted)]">Changes to this warehouse will be recorded here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <ul className="divide-y divide-[var(--border)]">
          {result.entries.map((e) => (
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
      <Pagination
        page={Math.min(result.page, result.totalPages)}
        totalPages={result.totalPages}
        total={result.total}
        label="entries"
        onPage={(n) => patchPage(n)}
      />
    </div>
  );
}
