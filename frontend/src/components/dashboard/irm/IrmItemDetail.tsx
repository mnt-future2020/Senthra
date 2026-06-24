"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Activity, Boxes, ClipboardList, Loader2, Pencil, Power, ScrollText } from "lucide-react";

import * as irmService from "@/services/irm.service";
import * as auditService from "@/services/audit.service";
import { printSingleLabel } from "@/lib/printBarcode";
import { BarcodePanel } from "@/components/dashboard/irm/BarcodePanel";
import { useAuth } from "@/hooks/useAuth";
import { useDashboard } from "@/hooks/useDashboard";

type PushToast = (msg: string, type?: "success" | "info" | "alert") => void;
import { StatusBadge } from "@/components/ui/StatusBadge";
import { actionLabel, actionTone, relativeTime, TONE_CLASSES } from "@/components/dashboard/audit/auditDisplay";
import { AuditTrailSkeleton } from "@/components/dashboard/audit/AuditTrailSkeleton";
import type { AuditEntry } from "@/types/audit";
import type { IrmItem } from "@/types/irm";
import type { UserStatus } from "@/types/user";

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtCost(item: IrmItem): string {
  if (item.standardCost == null) return "—";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: item.currency ?? "GBP" }).format(item.standardCost);
  } catch {
    return `${item.standardCost}`;
  }
}

type Tab = "overview" | "stock" | "purchase-orders" | "movements" | "audit";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "stock", label: "Stock Levels" },
  { key: "purchase-orders", label: "Purchase Orders" },
  { key: "movements", label: "Movements" },
  { key: "audit", label: "Audit trail" },
];

export function IrmItemDetail({ initial }: { initial: IrmItem }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const { pushToast } = useDashboard();
  const [i, setI] = React.useState<IrmItem>(initial);
  const [busy, setBusy] = React.useState(false);
  const canEdit = can("irm.edit");
  const canManageBarcode = can("irm.barcode.manage");

  const requestedTab = searchParams.get("tab");
  const tab: Tab = TABS.find((t) => t.key === requestedTab)?.key ?? "overview";
  const selectTab = (t: Tab) =>
    router.replace(`/dashboard/irm/${i.code}?tab=${t}`, { scroll: false });

  const toggleStatus = async () => {
    const next = i.status === "active" ? "inactive" : "active";
    setBusy(true);
    try {
      const updated = await irmService.updateIrmItem(i.id, { status: next });
      setI(updated);
      pushToast(next === "inactive" ? "Item deactivated." : "Item activated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not update the item.", "alert");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div
        className="flex flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-start sm:justify-between"
        style={{ borderRadius: "var(--radius)" }}
      >
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">{i.name}</h1>
            <StatusBadge status={i.status as UserStatus} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span className="font-mono">{i.code}</span>
            <span aria-hidden>·</span>
            <span>{i.type?.name ?? "—"}</span>
            <span aria-hidden>·</span>
            <span>{i.category?.name ?? "—"}</span>
          </p>
        </div>
        {canEdit && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={toggleStatus}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-xl border border-[var(--border)] px-3 py-2 text-xs font-bold text-[var(--ink)] transition-all hover:bg-[var(--surface-2)] disabled:opacity-60"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              {i.status === "active" ? "Deactivate" : "Activate"}
            </button>
            <button
              type="button"
              onClick={() => router.push(`/dashboard/irm/${i.code}/edit`)}
              className="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
            >
              <Pencil className="h-3.5 w-3.5" /> Edit
            </button>
          </div>
        )}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => selectTab(t.key)}
            className={`shrink-0 border-b-2 px-3.5 py-2.5 text-xs font-bold transition-colors ${
              tab === t.key ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <Overview i={i} costLabel={fmtCost(i)} canManageBarcode={canManageBarcode} onChange={setI} pushToast={pushToast} />
      )}
      {tab === "stock" && (
        <Placeholder icon={Boxes} title="Stock Levels" body="On-hand and available quantities per warehouse will appear here once the inventory module is connected." />
      )}
      {tab === "purchase-orders" && (
        <Placeholder icon={ClipboardList} title="Purchase Orders" body="Purchase orders for this item will be listed here once the procurement module is live." />
      )}
      {tab === "movements" && (
        <Placeholder icon={Activity} title="Movements" body="Goods in/out, transfers and adjustments for this item will be listed here once inventory movements are live." />
      )}
      {tab === "audit" && <AuditTrail itemId={i.id} />}
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

function Overview({
  i,
  costLabel,
  canManageBarcode,
  onChange,
  pushToast,
}: {
  i: IrmItem;
  costLabel: string;
  canManageBarcode: boolean;
  onChange: (item: IrmItem) => void;
  pushToast: PushToast;
}) {
  const num = (n: number | null) => (n == null ? "" : String(n));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Classification">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{i.type?.name ?? "—"}</Field>
          <Field label="Category">{i.category?.name ?? "—"}</Field>
          <Field label="Brand">{i.brand}</Field>
          <Field label="Manufacturer">{i.manufacturer}</Field>
          <Field label="MPN">{i.mpn}</Field>
          {i.description && <div className="col-span-2"><Field label="Description">{i.description}</Field></div>}
        </div>
      </Card>

      <Card title="Identification">
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU">{i.sku}</Field>
          <Field label="Base unit">{i.baseUnit}</Field>
          <Field label="Barcode">{i.barcode}</Field>
          <Field label="QR code">{i.qrCode}</Field>
          <Field label="Pack size">{num(i.packSize)}</Field>
          <Field label="Conversion ratio">{num(i.conversionRatio)}</Field>
        </div>
      </Card>

      <BarcodeCard i={i} canManage={canManageBarcode} onChange={onChange} pushToast={pushToast} />

      <Card title="Suppliers">
        {i.suppliers.length === 0 ? (
          <span className="text-sm text-[var(--faint)]">No suppliers linked</span>
        ) : (
          <ul className="space-y-2">
            {i.suppliers.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-semibold text-[var(--ink)]">{s.supplier?.name ?? "—"}</span>
                {s.supplier && <span className="font-mono text-[11px] text-[var(--faint)]">{s.supplier.code}</span>}
                {s.isPrimary && (
                  <span className="rounded-full bg-[var(--accent-10)] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--accent)]">Primary</span>
                )}
                {s.supplierSku && <span className="text-[11px] text-[var(--muted)]">Supplier item code: {s.supplierSku}</span>}
                {s.leadTimeDays != null && <span className="text-[11px] text-[var(--muted)]">{s.leadTimeDays}d lead</span>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Cost (internal)">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Standard cost">{costLabel}</Field>
          <Field label="Currency">{i.currency}</Field>
          <Field label="VAT rate">{i.vatRatePercent != null ? `${i.vatRatePercent}%` : ""}</Field>
        </div>
      </Card>

      <Card title="Stock policies">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Minimum">{num(i.minimumStock)}</Field>
          <Field label="Reorder level">{num(i.reorderLevel)}</Field>
          <Field label="Reorder qty">{num(i.reorderQuantity)}</Field>
          <Field label="Maximum">{num(i.maximumStock)}</Field>
          <Field label="Safety">{num(i.safetyStock)}</Field>
          <Field label="Critical">{num(i.criticalLevel)}</Field>
        </div>
      </Card>

      <Card title="Tracking & owner">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Track inventory">{i.trackInventory ? "Yes" : "No"}</Field>
          <Field label="Serial numbers">{i.trackSerialNumbers ? "Yes" : "No"}</Field>
          <Field label="Batch numbers">{i.trackBatchNumbers ? "Yes" : "No"}</Field>
          <div className="col-span-2">
            <Field label="Internal owner">
              {i.owner ? (
                <div>
                  <span className="font-semibold">{i.owner.name}</span>
                  {i.owner.jobTitle && <span className="ml-1.5 text-xs font-normal text-[var(--muted)]">· {i.owner.jobTitle}</span>}
                </div>
              ) : (
                <span className="text-[var(--faint)]">No owner assigned</span>
              )}
            </Field>
          </div>
          {i.notes && <div className="col-span-2"><Field label="Notes">{i.notes}</Field></div>}
        </div>
      </Card>

      <Card title="Record">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Created">{fmtDate(i.createdAt)}</Field>
          <Field label="Updated">{fmtDate(i.updatedAt)}</Field>
          <Field label="Created by">{i.createdBy}</Field>
          <Field label="Updated by">{i.updatedBy}</Field>
        </div>
      </Card>
    </div>
  );
}

// Barcode card: render the item's Code128 image (permanently encodes the item code, e.g. IRM-0004).
// Generate is a ONE-TIME action; once a barcode exists only "Reprint Label" is offered (reuses the
// stored barcode + image — never a new value/number). Bulk printing is a future seam (printBulkLabels).
function BarcodeCard({
  i,
  canManage,
  onChange,
  pushToast,
}: {
  i: IrmItem;
  canManage: boolean;
  onChange: (item: IrmItem) => void;
  pushToast: PushToast;
}) {
  const [busy, setBusy] = React.useState(false);

  const generate = async () => {
    setBusy(true);
    try {
      const updated = await irmService.generateBarcode(i.id);
      onChange(updated);
      pushToast("Barcode generated.", "success");
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not generate the barcode.", "alert");
    } finally {
      setBusy(false);
    }
  };

  const print = () => {
    if (!i.barcodeDataUri) return;
    printSingleLabel({ dataUri: i.barcodeDataUri, code: i.code });
  };

  return (
    <Card title="Barcode">
      <BarcodePanel
        code={i.code}
        barcodeDataUri={i.barcodeDataUri}
        canManage={canManage}
        busy={busy}
        onGenerate={generate}
        onPrint={print}
      />
    </Card>
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
      <span className="mt-1 rounded-full bg-[var(--surface-2)] px-2.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wider text-[var(--faint)]">Coming soon</span>
    </div>
  );
}

function AuditTrail({ itemId }: { itemId: string }) {
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    auditService
      .listAuditLogs({ targetType: "irm_item", pageSize: 100 })
      .then((res) => {
        if (active) setEntries(res.entries.filter((e) => e.targetId === itemId));
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load the audit trail.");
      });
    return () => {
      active = false;
    };
  }, [itemId]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (entries === null) return <AuditTrailSkeleton />;
  if (entries.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
        <ScrollText className="h-7 w-7 text-[var(--faint)]" />
        <p className="text-sm font-semibold text-[var(--ink)]">No activity yet</p>
        <p className="text-xs text-[var(--muted)]">Changes to this item will be recorded here.</p>
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <ul className="divide-y divide-[var(--border)]">
        {entries.map((e) => (
          <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex items-center gap-3">
              <span className={`inline-block shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold ${TONE_CLASSES[actionTone(e.action)]}`}>
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
