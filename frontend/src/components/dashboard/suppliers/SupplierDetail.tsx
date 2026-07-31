"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Pencil, Power, ScrollText } from "lucide-react";

import * as supplierService from "@/services/supplier.service";
import * as auditService from "@/services/audit.service";
import * as poService from "@/services/purchase-order.service";
import * as prfService from "@/services/purchase-request.service";
import * as irmService from "@/services/irm.service";
import * as grnService from "@/services/goods-in.service";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";
import { NoStaffAssigned, StaffChip } from "@/components/ui/StaffChip";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { Pagination } from "@/components/ui/Pagination";
import { Skeleton } from "@/components/ui/Skeleton";
import { actionLabel, actionTone, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { AuditTrailSkeleton } from "@/components/dashboard/audit/AuditTrailSkeleton";
import { PoStatusBadge, formatMoney, formatDate as poDate } from "@/components/dashboard/purchase-orders/poStatus";
import { PrfStatusBadge } from "@/components/dashboard/purchase-requests/prfStatus";
import type { AuditEntry, PagedAuditLogs } from "@/types/audit";
import type { IrmItem } from "@/types/irm";
import type { GoodsReceipt } from "@/types/goods-in";
import type { PurchaseOrder } from "@/types/purchase-order";
import type { PurchaseRequest } from "@/types/purchase-request";
import type { Supplier } from "@/types/supplier";
import type { UserStatus } from "@/types/user";

const AUDIT_PAGE_SIZE = 20;

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

// The displayed payment term — "Custom" shows the free-text value.
function paymentTermsLabel(s: Supplier): string {
  if (!s.paymentTerms) return "—";
  if (s.paymentTerms === "Custom") return s.customPaymentTerms || "Custom";
  return s.paymentTerms;
}

type Tab = "overview" | "items" | "procurement" | "goods-in" | "audit";

export function SupplierDetail({ initial }: { initial: Supplier }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [s, setS] = React.useState<Supplier>(initial);
  const [busy, setBusy] = React.useState(false);

  // Every tab that calls an endpoint is gated on that endpoint's OWN permission. Items and Goods In
  // used to be static "coming soon" cards, so being ungated cost nothing; now that they actually fetch
  // (`/irm-items` needs irm.view, `/goods-in` needs goods_in.view) an ungated tab is a tab that is
  // visible to someone who can only ever get a 403 out of it.
  const tab$ = (key: Tab, label: string) => [{ key, label }] as { key: Tab; label: string }[];
  const TABS: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    ...(can("irm.view") ? tab$("items", "Items") : []),
    ...(can("purchase_orders.view") ? tab$("procurement", "Procurement") : []),
    ...(can("goods_in.view") ? tab$("goods-in", "Goods In") : []),
    { key: "audit", label: "Audit trail" },
  ];

  const requestedTab = searchParams.get("tab");
  const tab: Tab = TABS.find((t) => t.key === requestedTab)?.key ?? "overview";
  const selectTab = (key: Tab) =>
    router.replace(`/dashboard/suppliers/${s.code}?tab=${key}`, { scroll: false });
  const canEdit = can("suppliers.edit");

  const toggleStatus = async () => {
    const next = s.status === "active" ? "inactive" : "active";
    setBusy(true);
    try {
      const updated = await supplierService.updateSupplier(s.id, { status: next });
      setS(updated);
      pushToast(next === "inactive" ? "Supplier deactivated." : "Supplier activated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the supplier.", "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col gap-5">
      <DetailHeader
        storageKey="supplier-detail"
        title={s.name}
        badges={<StatusBadge status={s.status as UserStatus} />}
        meta={
          <>
            <span className="font-mono">{s.code}</span>
            <span aria-hidden>·</span>
            <span>{s.type?.name ?? "—"}</span>
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
                {s.status === "active" ? "Deactivate" : "Activate"}
              </button>
              <button
                type="button"
                onClick={() => router.push(`/dashboard/suppliers/${s.code}/edit`)}
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
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => selectTab(t.key)}
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

      <div className="min-h-0 flex-1 overflow-auto">
        {tab === "overview" && <Overview s={s} />}
        {tab === "items" && (
          <SupplierItems supplierId={s.id} />
        )}
        {tab === "procurement" && <Procurement supplier={s} />}
        {tab === "goods-in" && (
          <SupplierGoodsIn supplierId={s.id} />
        )}
        {tab === "audit" && <AuditTrail supplierId={s.id} />}
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

function Overview({ s }: { s: Supplier }) {
  const addressLines = [s.addressLine1, s.addressLine2, s.city, s.county, s.postcode, s.country]
    .map((l) => l?.trim())
    .filter(Boolean);
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Business">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Legal business name">{s.legalName}</Field>
          <Field label="Website">
            {s.website ? (
              <a
                className="text-[var(--accent)] hover:underline"
                href={/^https?:\/\//i.test(s.website) ? s.website : `https://${s.website}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {s.website}
              </a>
            ) : (
              ""
            )}
          </Field>
          <Field label="Company reg. number">{s.companyRegistrationNumber}</Field>
          <Field label="VAT number">{s.vatNumber}</Field>
          {s.description && (
            <div className="col-span-2">
              <Field label="Description">{s.description}</Field>
            </div>
          )}
        </div>
      </Card>

      <Card title="Address">
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
      </Card>

      <Card title="Contact">
        <div className="space-y-3">
          <Field label="Contact person">
            {s.contactPerson ? (
              <span>
                {s.contactPerson}
                {s.contactJobTitle && (
                  <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">· {s.contactJobTitle}</span>
                )}
              </span>
            ) : (
              ""
            )}
          </Field>
          <Field label="Email">
            {s.contactEmail ? (
              <a className="text-[var(--accent)] hover:underline" href={`mailto:${s.contactEmail}`}>
                {s.contactEmail}
              </a>
            ) : (
              ""
            )}
          </Field>
          <Field label="Phone">
            {s.contactPhone ? (
              <a className="text-[var(--accent)] hover:underline" href={`tel:${s.contactPhone}`}>
                {s.contactPhone}
              </a>
            ) : (
              ""
            )}
          </Field>
        </div>
      </Card>

      <Card title="Payment & operations">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Payment terms">{paymentTermsLabel(s)}</Field>
          <Field label="Currency">{s.currency}</Field>
          <Field label="Lead time">{s.leadTimeDays != null ? `${s.leadTimeDays} days` : ""}</Field>
          <div className="col-span-2">
            <Field label="Notes">{s.notes}</Field>
          </div>
        </div>
      </Card>

      <Card title="Management">
        <Field label="Internal owner">
          {s.owner ? (
            <div className="mt-2">
              <StaffChip staff={s.owner} />
            </div>
          ) : (
            <NoStaffAssigned label="No owner assigned" />
          )}
        </Field>
      </Card>

      <Card title="Record">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{s.type?.name ?? "—"}</Field>
          <Field label="Code">{s.code}</Field>
          <Field label="Created">{fmtDate(s.createdAt)}</Field>
          <Field label="Updated">{fmtDate(s.updatedAt)}</Field>
          <Field label="Created by">{s.createdBy}</Field>
          <Field label="Updated by">{s.updatedBy}</Field>
        </div>
      </Card>
    </div>
  );
}

// Procurement summary tiles + recent POs / PRFs for this supplier. Counts and spend come from
// the dedicated summary endpoint; the two lists reuse the standard list endpoints filtered by
// supplier. Everything deep-links into the owning module — nothing procurement-shaped is
// duplicated here.
function Procurement({ supplier }: { supplier: Supplier }) {
  const router = useRouter();
  const { can } = useAuth();
  const canViewPrfs = can("purchase_requests.view");
  const [summary, setSummary] = React.useState<poService.SupplierProcurementSummary | null>(null);
  const [orders, setOrders] = React.useState<PurchaseOrder[] | null>(null);
  const [requests, setRequests] = React.useState<PurchaseRequest[] | null>(canViewPrfs ? null : []);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    poService
      .getSupplierProcurementSummary(supplier.id)
      .then((res) => active && setSummary(res))
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load the procurement summary."));
    poService
      .listPurchaseOrders({ supplier: supplier.id, pageSize: 5 })
      .then((res) => active && setOrders(res.purchaseOrders))
      .catch(() => active && setOrders([]));
    if (canViewPrfs) {
      prfService
        .listPurchaseRequests({ supplier: supplier.id, pageSize: 5 })
        .then((res) => active && setRequests(res.purchaseRequests))
        .catch(() => active && setRequests([]));
    }
    return () => {
      active = false;
    };
  }, [supplier.id, canViewPrfs]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;

  const tiles = summary
    ? [
        { label: "Total POs", value: String(summary.purchaseOrders.total) },
        { label: "Outstanding", value: String(summary.purchaseOrders.outstanding) },
        { label: "Open", value: String(summary.purchaseOrders.open) },
        { label: "Cancelled", value: String(summary.purchaseOrders.cancelled) },
        { label: "Total spend", value: formatMoney(summary.purchaseOrders.spend) },
        { label: "PRFs", value: String(summary.purchaseRequests.total) },
      ]
    : null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {tiles
          ? tiles.map((t) => (
              <div key={t.label} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{t.label}</p>
                <p className="mt-1 text-lg font-extrabold tracking-tight text-[var(--ink)]">{t.value}</p>
              </div>
            ))
          : Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="mt-2 h-5 w-12" />
              </div>
            ))}
      </div>

      <div className={`grid gap-4 ${canViewPrfs ? "lg:grid-cols-2" : ""}`}>
        <Card title="Recent purchase orders">
          {orders === null ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-xl" />
              ))}
            </div>
          ) : orders.length === 0 ? (
            <p className="py-6 text-center text-xs text-[var(--muted)]">No purchase orders raised against this supplier yet.</p>
          ) : (
            <ul className="divide-y divide-[var(--border-2)]">
              {orders.map((po) => (
                <li key={po.id}>
                  <button
                    type="button"
                    onClick={() => router.push(`/dashboard/purchase-orders/${po.code}`)}
                    className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)]"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="font-mono text-xs text-[var(--muted)]">{po.code}</span>
                      <PoStatusBadge status={po.status} />
                    </span>
                    <span className="flex shrink-0 items-center gap-3 text-[11px] text-[var(--muted)]">
                      <span className="font-semibold text-[var(--ink)]">{formatMoney(po.grandTotal, po.currency)}</span>
                      <span className="text-[var(--faint)]">{poDate(po.orderDate)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {canViewPrfs && (
          <Card title="Recent purchase requests">
            {requests === null ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 w-full rounded-xl" />
                ))}
              </div>
            ) : requests.length === 0 ? (
              <p className="py-6 text-center text-xs text-[var(--muted)]">No purchase requests for this supplier yet.</p>
            ) : (
              <ul className="divide-y divide-[var(--border-2)]">
                {requests.map((prf) => (
                  <li key={prf.id}>
                    <button
                      type="button"
                      onClick={() => router.push(`/dashboard/purchase-requests/${prf.code}`)}
                      className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)]"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="font-mono text-xs text-[var(--muted)]">{prf.code}</span>
                        <PrfStatusBadge status={prf.status} />
                      </span>
                      <span className="flex shrink-0 items-center gap-3 text-[11px] text-[var(--muted)]">
                        <span className="font-semibold text-[var(--ink)]">{formatMoney(prf.grandTotal, prf.currency)}</span>
                        <span className="text-[var(--faint)]">{poDate(prf.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

// Catalogue items this supplier supplies.
//
// Replaced a "Coming soon" card reading "once the IRM catalogue module is connected". The catalogue
// has been live for a long time and the item list ALREADY accepted a supplier filter
// (irm.repository: `where.suppliers = { some: { supplierId } }`) — nothing needed building, only
// connecting. An item can have several suppliers with one primary, so this is the "supplies it at
// all" set, not "sourced from here by default".
function SupplierItems({ supplierId }: { supplierId: string }) {
  const router = useRouter();
  const [items, setItems] = React.useState<IrmItem[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    irmService
      .listIrmItems({ supplier: supplierId, pageSize: 50 })
      .then((r) => {
        if (!active) return;
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load this supplier's items."));
    return () => { active = false; };
  }, [supplierId]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (items === null) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center text-xs text-[var(--muted)]">
        No catalogue items list this supplier yet.
      </p>
    );
  }

  return (
    <Card title={`Catalogue items (${total})`}>
      <ul className="divide-y divide-[var(--border-2)]">
        {items.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              // `/dashboard/irm/<code>` — the item detail lives under `irm`, not `inventory`, and the
              // page resolves an id OR a code. Same target IrmItemDetail and IrmItemForm push to.
              onClick={() => router.push(`/dashboard/irm/${it.code}`)}
              className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)]"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="font-mono text-xs text-[var(--muted)]">{it.code}</span>
                <span className="truncate text-sm font-semibold text-[var(--ink)]">{it.name}</span>
              </span>
              <span className="shrink-0 text-[11px] text-[var(--faint)]">{it.sku ?? "—"}</span>
            </button>
          </li>
        ))}
      </ul>
      {/* Stated rather than silently truncated — a list that stops at 50 with no note reads as the
          complete set. */}
      {total > items.length && (
        <p className="pt-3 text-[11px] text-[var(--faint)]">
          Showing the first {items.length} of {total}. Open Inventory to see them all.
        </p>
      )}
    </Card>
  );
}

// Deliveries received from this supplier. Same story as the Items tab: the goods-in module is live
// and GoodsReceipt already carried a denormalised `supplierId` WITH its own `@@index([supplierId])`
// — the index existed for precisely this lookup. Only the list filter had to be threaded through.
function SupplierGoodsIn({ supplierId }: { supplierId: string }) {
  const router = useRouter();
  const [receipts, setReceipts] = React.useState<GoodsReceipt[] | null>(null);
  const [total, setTotal] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    grnService
      .listGoodsReceipts({ supplier: supplierId, pageSize: 50 })
      .then((r) => {
        if (!active) return;
        setReceipts(r.goodsReceipts);
        setTotal(r.total);
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : "Could not load this supplier's deliveries."));
    return () => { active = false; };
  }, [supplierId]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (receipts === null) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-xl" />)}
      </div>
    );
  }
  if (receipts.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center text-xs text-[var(--muted)]">
        Nothing has been received from this supplier yet.
      </p>
    );
  }

  return (
    <Card title={`Goods receipts (${total})`}>
      <ul className="divide-y divide-[var(--border-2)]">
        {receipts.map((g) => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => router.push(`/dashboard/goods-in/${g.code}`)}
              className="flex w-full items-center justify-between gap-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-2)]"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="font-mono text-xs text-[var(--muted)]">{g.code}</span>
                <span className="truncate text-[11px] text-[var(--muted)]">{g.warehouse?.name ?? "—"}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3 text-[11px] text-[var(--muted)]">
                <span className="font-mono text-[var(--faint)]">{g.poCode ?? "—"}</span>
                <span className="text-[var(--faint)]">{poDate(g.receivedDate)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {total > receipts.length && (
        <p className="pt-3 text-[11px] text-[var(--faint)]">
          Showing the first {receipts.length} of {total}. Open Goods In to see them all.
        </p>
      )}
    </Card>
  );
}

// Supplier-specific audit history. The API supports server-side pagination;
// we pass targetId + targetType so the server filters to this supplier's rows.
function AuditTrail({ supplierId }: { supplierId: string }) {
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
      .listAuditLogs({ targetType: "supplier", targetId: supplierId, page, pageSize: AUDIT_PAGE_SIZE })
      .then((res) => {
        if (!controller.signal.aborted) setResult(res);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Could not load the audit trail.");
      });
    return () => {
      controller.abort();
      setResult(null);
    };
  }, [supplierId, page]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (result === null) return <AuditTrailSkeleton />;

  const entries: AuditEntry[] = result.entries;

  if (result.total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <ScrollText className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No activity yet</p>
        <p className="text-xs text-[var(--muted)]">Changes to this supplier will be recorded here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
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
