"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowLeftRight, Loader2, PackageSearch, ScrollText } from "lucide-react";

import * as inventoryService from "@/services/inventory.service";
import { useAuth } from "@/hooks/useAuth";
import { Pagination } from "@/components/ui/Pagination";
import { InventoryStatusBadge, formatDate, formatDateTime, formatDelta, formatMoney, formatTxnType } from "./inventoryStatus";
import type { InventoryDetail as InventoryDetailType, InventoryTransaction, PurchaseHistoryRow } from "@/types/inventory";

type Tab = "overview" | "transactions" | "purchases";
const TXN_PAGE_SIZE = 20;

export function InventoryDetail({ initial }: { initial: InventoryDetailType }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { can } = useAuth();
  const TABS: Tab[] = ["overview", "transactions", "purchases"];
  const requestedTab = searchParams.get("tab");
  const tab: Tab = TABS.includes(requestedTab as Tab) ? (requestedTab as Tab) : "overview";
  const setTab = (t: Tab) => router.replace(`/dashboard/inventory/${initial.id}?tab=${t}`, { scroll: false });
  const inv = initial;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 border border-[var(--border)] bg-[var(--surface)] p-5 shadow-xs sm:flex-row sm:items-start sm:justify-between" style={{ borderRadius: "var(--radius)" }}>
        <div className="min-w-0">
          <button onClick={() => router.push("/dashboard/inventory")} className="mb-2 flex items-center gap-1.5 text-[11px] font-bold text-[var(--muted)] transition-colors hover:text-[var(--ink)]">
            <ArrowLeft className="h-3.5 w-3.5" /> Back to inventory
          </button>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-extrabold tracking-tight text-[var(--ink)]">{inv.itemName}</h1>
            <InventoryStatusBadge status={inv.status} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <span className="font-mono">{inv.itemCode}</span>
            {inv.sku && (<><span aria-hidden>·</span><span>SKU {inv.sku}</span></>)}
            <span aria-hidden>·</span>
            <span>{inv.warehouseName} ({inv.warehouseCode})</span>
            <span aria-hidden>·</span>
            <span>Updated {formatDate(inv.lastMovementAt)}</span>
          </p>
        </div>
        {can("inventory.move") && inv.available > 0 && !inv.trackSerialNumbers && !inv.trackBatchNumbers && (
          <button onClick={() => router.push(`/dashboard/inventory/move?item=${inv.irmItemId}&from=${inv.warehouseId}`)} className="flex shrink-0 items-center gap-1.5 rounded-xl bg-[var(--accent)] px-3.5 py-2.5 text-xs font-extrabold text-white transition-all hover:opacity-90">
            <ArrowLeftRight className="h-4 w-4" /> Move stock
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="On hand" value={`${inv.onHand}${inv.baseUnit ? ` ${inv.baseUnit}` : ""}`} strong />
        <Stat label="Reserved" value={String(inv.reserved)} />
        <Stat label="Available" value={String(inv.available)} strong />
        <Stat label="Stock value" value={formatMoney(inv.value, inv.currency)} />
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {([["overview", "Overview"], ["transactions", "Transaction history"], ["purchases", "Purchase history"]] as [Tab, string][]).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className={`shrink-0 border-b-2 px-3.5 py-2.5 text-xs font-bold transition-colors ${tab === t ? "border-[var(--accent)] text-[var(--accent)]" : "border-transparent text-[var(--muted)] hover:text-[var(--ink)]"}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === "overview" && <Overview inv={inv} />}
      {tab === "transactions" && <Transactions balanceId={inv.id} warehouseName={inv.warehouseName} />}
      {tab === "purchases" && <Purchases balanceId={inv.id} />}
    </div>
  );
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">{label}</p>
      <p className={`mt-1 ${strong ? "text-xl font-extrabold" : "text-lg font-bold"} text-[var(--ink)]`}>{value}</p>
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

function Overview({ inv }: { inv: InventoryDetailType }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Stock position">
        <div className="grid grid-cols-2 gap-3">
          <Field label="On hand">{inv.onHand}{inv.baseUnit ? ` ${inv.baseUnit}` : ""}</Field>
          <Field label="Reserved (outgoing)">{inv.outgoing}</Field>
          <Field label="Available">{inv.available}</Field>
          <Field label="Incoming (open POs)">{inv.incoming}</Field>
          <Field label="Last movement">{formatDate(inv.lastMovementAt)}</Field>
          <Field label="Status">{inv.status === "in_stock" ? "In stock" : inv.status === "low_stock" ? "Low stock" : "Out of stock"}</Field>
        </div>
      </Card>
      <Card title="Item & valuation">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Item code">{inv.itemCode}</Field>
          <Field label="SKU">{inv.sku}</Field>
          <Field label="Category">{inv.categoryName}</Field>
          <Field label="Base unit">{inv.baseUnit}</Field>
          <Field label="Reorder level">{inv.reorderLevel ?? "—"}</Field>
          <Field label="Unit cost">{formatMoney(inv.unitCostPence / 100, inv.currency)}</Field>
          <Field label="Stock value">{formatMoney(inv.value, inv.currency)}</Field>
          <Field label="Tracking">{inv.trackSerialNumbers ? "Serial" : inv.trackBatchNumbers ? "Batch" : "Standard"}</Field>
        </div>
      </Card>
    </div>
  );
}

function Transactions({ balanceId, warehouseName }: { balanceId: string; warehouseName: string }) {
  const [data, setData] = React.useState<inventoryService.PagedTransactions | null>(null);
  const [page, setPage] = React.useState(1);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      setError(null);
      try {
        const r = await inventoryService.listInventoryTransactions(balanceId, page, TXN_PAGE_SIZE);
        if (active) setData(r);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load the transaction history.");
      }
    })();
    return () => { active = false; };
  }, [balanceId, page]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (!data) return <Center><Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" /></Center>;
  if (data.transactions.length === 0) return <Empty icon={ScrollText} text="No movements recorded yet" />;

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Date</th><th className="px-4 py-3">Type</th><th className="px-4 py-3 text-right">Quantity</th>
                <th className="px-4 py-3 text-right">Balance after</th><th className="px-4 py-3">Warehouse</th><th className="px-4 py-3">Reference</th><th className="px-4 py-3">By</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t: InventoryTransaction) => (
                <tr key={t.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3 text-[var(--muted)]">{formatDateTime(t.date)}</td>
                  <td className="px-4 py-3 text-[var(--ink)]">{formatTxnType(t.type)}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${t.quantityDelta < 0 ? "text-rose-600" : "text-emerald-600"}`}>{formatDelta(t.quantityDelta)}</td>
                  <td className="px-4 py-3 text-right text-[var(--ink)]">{t.balanceAfter}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{t.warehouseName || warehouseName}</td>
                  <td className="px-4 py-3 font-mono text-[11px] text-[var(--muted)]">{t.reference ?? "—"}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{t.createdBy ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {data.total > 0 && <Pagination page={data.page} totalPages={data.totalPages} total={data.total} label="movements" onPage={setPage} />}
    </div>
  );
}

function Purchases({ balanceId }: { balanceId: string }) {
  const [rows, setRows] = React.useState<PurchaseHistoryRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      setError(null);
      try {
        const r = await inventoryService.listPurchaseHistory(balanceId);
        if (active) setRows(r);
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "Could not load the purchase history.");
      }
    })();
    return () => { active = false; };
  }, [balanceId]);

  if (error) return <p className="py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</p>;
  if (!rows) return <Center><Loader2 className="h-6 w-6 animate-spin text-[var(--muted)]" /></Center>;
  if (rows.length === 0) return <Empty icon={PackageSearch} text="No completed receipts for this item here yet" />;

  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              <th className="px-4 py-3">Goods receipt</th><th className="px-4 py-3">Purchase order</th><th className="px-4 py-3">Supplier</th>
              <th className="px-4 py-3 text-right">Received</th><th className="px-4 py-3">Date</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.grnCode}-${i}`} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{r.grnCode}</td>
                <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{r.poCode ?? "—"}</td>
                <td className="px-4 py-3 text-[var(--ink)]">{r.supplierName ?? "—"}</td>
                <td className="px-4 py-3 text-right font-semibold text-[var(--ink)]">{r.receivedQuantity}</td>
                <td className="px-4 py-3 text-[var(--muted)]">{formatDate(r.receivedDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center justify-center rounded-2xl border border-[var(--border)] bg-[var(--surface)] py-16">{children}</div>;
}
function Empty({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface)] py-16 text-center">
      <Icon className="h-7 w-7 text-[var(--faint)]" />
      <p className="text-sm font-semibold text-[var(--ink)]">{text}</p>
    </div>
  );
}
