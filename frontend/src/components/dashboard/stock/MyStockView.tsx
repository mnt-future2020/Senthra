"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Boxes } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import { Pagination } from "@/components/ui/Pagination";
import type { PagedStockEntries } from "@/services/customer.service";
import {
  EmptyState,
  fmtDate,
  HeaderCardSkeleton,
  PortalHeader,
  TableCard,
  TableCardSkeleton,
} from "@/components/dashboard/portal/portalUi";
import type { Msg } from "@/components/ui/types";

const HEADERS = ["Item", "Warehouse", "SKU", "Qty", "Barcode", "Status", "Received"];
const SKELETON_CELLS = ["h-3 w-32", "h-3 w-28", "h-3 w-16", "h-3 w-10", "h-3 w-20", "h-3 w-14", "h-3 w-20"];

// Customer portal — My Stock. Server-paged (consignment entries accumulate forever); the page
// lives in the URL (?page) so it survives a refresh — same pattern as every other list.
export function MyStockView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const page = Math.max(1, Number(searchParams.get("page")) || 1);

  const [paged, setPaged] = React.useState<PagedStockEntries | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    let active = true;
    void (async () => {
      if (active) setLoading(true);
      try {
        const r = await customerService.getOwnStockEntries({ page, pageSize: 20 });
        if (active) setPaged(r);
      } catch (err) {
        if (active) setMsg({ type: "error", text: err instanceof Error ? err.message : "Could not load your stock." });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [page]);

  const setPage = (p: number) => {
    const params = new URLSearchParams(window.location.search);
    if (p > 1) params.set("page", String(p));
    else params.delete("page");
    router.replace(`/dashboard/stock?${params.toString()}`, { scroll: false });
  };

  const entries = paged?.entries ?? [];

  if (loading && paged === null) {
    return (
      <div className="flex h-full flex-col gap-6">
        <HeaderCardSkeleton />
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} fill />
      </div>
    );
  }

  if (msg?.type === "error") return <Notice msg={msg} />;

  return (
    <div className="flex h-full flex-col gap-6">
      <PortalHeader
        title="My Stock"
        subtitle="All your stock currently held across our warehouses."
      />

      {loading ? (
        <TableCardSkeleton headers={HEADERS} cells={SKELETON_CELLS} fill />
      ) : entries.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="No stock entries yet"
          hint="Once your stock is received at a warehouse, it will appear here."
        />
      ) : (
        <>
          <TableCard headers={HEADERS} minWidth={750} fill>
            {entries.map((e) => (
              <tr key={e.id} className="border-b border-[var(--border)] last:border-0">
                <td className="px-4 py-3 font-semibold text-[var(--ink)]">{e.itemName}</td>
                <td className="px-4 py-3">
                  <div className="text-[var(--ink)]">{e.warehouseName}</div>
                  <div className="font-mono text-[11px] text-[var(--faint)]">{e.warehouseCode}</div>
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
              </tr>
            ))}
          </TableCard>
          <div className="shrink-0">
            <Pagination
              page={paged?.page ?? 1}
              totalPages={paged?.totalPages ?? 1}
              total={paged?.total ?? 0}
              label="entries"
              onPage={setPage}
            />
          </div>
        </>
      )}
    </div>
  );
}
