"use client";

// DamagedStockView — renders damaged-stock rows for either a warehouse or a customer.
// Pass exactly one of warehouseId or customerId. No price/cost fields are displayed.

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import Image from "next/image";

import * as gmService from "@/services/goodsManagement.service";
import type { DamagedRow } from "@/types/goodsManagement";
import { ImageLightbox } from "@/components/ui/ImageLightbox";
import { Skeleton } from "@/components/ui/Skeleton";
import { Pagination } from "@/components/ui/Pagination";

const PAGE_SIZE = 20;

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function DamagedStockView({
  warehouseId,
  customerId,
}: {
  warehouseId?: string;
  customerId?: string;
}) {
  const [rows, setRows] = React.useState<DamagedRow[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<DamagedRow | null>(null); // open damage-photo lightbox
  const [page, setPage] = React.useState(1);

  React.useEffect(() => {
    let active = true;
    gmService
      .listDamaged({ warehouseId, customerId })
      .then((data) => {
        if (!active) return;
        setError(null);
        setRows(data);
        setPage(1); // reset paging when the scope (warehouse/customer) changes
      })
      .catch((e) => {
        if (!active) return;
        setError(
          e instanceof Error ? e.message : "Could not load damaged stock.",
        );
      });
    return () => {
      active = false;
    };
  }, [warehouseId, customerId]);

  const cols = warehouseId ? 6 : 7; // Photo, Item, Owner, [Warehouse], Reason, Qty, Last updated
  const total = rows?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  // Only the current page is rendered, so the table stays fast even with a large damaged-stock list.
  const pageRows = rows ? rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : [];

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <table className="w-full text-left text-sm" style={{ minWidth: 700 }}>
          <thead>
            <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
              <th className="px-4 py-3">Photo</th>
              <th className="px-4 py-3">Item</th>
              <th className="px-4 py-3">Owner</th>
              {warehouseId ? null : <th className="px-4 py-3">Warehouse</th>}
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3 text-right">Qty</th>
              <th className="px-4 py-3">Last updated</th>
            </tr>
          </thead>
          <tbody>
            {error ? (
              <tr><td colSpan={cols} className="px-4 py-12 text-center text-sm font-semibold text-[var(--neg)]">{error}</td></tr>
            ) : rows === null ? (
              // Skeleton rows — same layout as real data, so the table doesn't jump when it loads.
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3"><Skeleton className="h-10 w-10 rounded-lg" /></td>
                  {Array.from({ length: cols - 1 }).map((__, j) => (
                    <td key={j} className="px-4 py-3"><Skeleton className={`h-4 ${j === cols - 2 ? "w-16" : "w-24"}`} /></td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={cols} className="px-4 py-14">
                  <div className="flex flex-col items-center justify-center gap-2 text-center">
                    <AlertTriangle className="h-7 w-7 text-[var(--faint)]" />
                    <p className="text-sm font-semibold text-[var(--ink)]">No damaged stock</p>
                    <p className="text-xs text-[var(--muted)]">Damaged items returned from engineers will appear here.</p>
                  </div>
                </td>
              </tr>
            ) : (
              pageRows.map((row) => (
                <tr key={row.id} className="border-b border-[var(--border)] align-middle last:border-0">
                  {/* Photo thumbnail — opens the in-app preview modal */}
                  <td className="px-4 py-3">
                    {row.photoUrl ? (
                      <button
                        type="button"
                        onClick={() => setPreview(row)}
                        className="block h-10 w-10 overflow-hidden rounded-lg border border-[var(--border)] transition-opacity hover:opacity-80"
                        aria-label="View damage photo"
                      >
                        <Image src={row.photoUrl} alt="Damage photo" width={40} height={40} className="h-10 w-10 object-cover" unoptimized />
                      </button>
                    ) : (
                      <span className="text-xs text-[var(--faint)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{row.itemName}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold ${row.ownerType === "company" ? "bg-[var(--accent)]/12 text-[var(--accent)]" : "bg-indigo-500/12 text-indigo-600"}`}>
                      {row.ownerType === "company" ? "Company (IRM)" : "Customer"}
                    </span>
                  </td>
                  {warehouseId ? null : <td className="px-4 py-3 text-xs text-[var(--muted)]">{row.warehouseName ?? "—"}</td>}
                  <td className="max-w-[180px] px-4 py-3 text-xs text-[var(--muted)]">{row.reason ?? <span className="text-[var(--faint)]">—</span>}</td>
                  <td className="px-4 py-3 text-right font-bold text-[var(--neg)]">{row.quantity}</td>
                  <td className="px-4 py-3 text-xs text-[var(--muted)]">{fmtDate(row.updatedAt)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {rows && total > PAGE_SIZE && (
        <Pagination page={safePage} totalPages={totalPages} total={total} label="damaged items" onPage={setPage} />
      )}

      {preview?.photoUrl && (
        <ImageLightbox
          src={preview.photoUrl}
          alt={`Damage photo — ${preview.itemName}`}
          caption={
            <>
              <span className="font-semibold text-white">{preview.itemName}</span>
              {preview.reason ? <> · {preview.reason}</> : null}
            </>
          }
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
