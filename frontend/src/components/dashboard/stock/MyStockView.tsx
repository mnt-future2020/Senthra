"use client";

import * as React from "react";
import { Boxes, Info, ShieldCheck } from "lucide-react";

import * as customerService from "@/services/customer.service";
import { Notice } from "@/components/ui/Notice";
import {
  EmptyState,
  HeaderCardSkeleton,
  PortalHeader,
  TableCard,
  TableCardSkeleton,
} from "@/components/dashboard/portal/portalUi";
import type { CatalogueItem, CustomerStock } from "@/types/customer";
import type { Msg } from "@/components/ui/types";

const CATALOGUE_HEADERS = ["SKU", "Item", "Category", "Unit", "Details"];
const CATALOGUE_SKELETON_CELLS = ["h-3 w-16", "h-3 w-40", "h-3 w-20", "h-3 w-12", "h-3 w-32"];

// The customer's read-only stock view (Flow 9), rendered inside the dashboard shell.
//
// Live stock levels + movements come from the inventory module, which doesn't
// exist yet — so the backend returns `stock.available: false` and we show an
// honest "coming soon" banner alongside the customer's real stock catalogue (the
// items their stock is tracked against). When the inventory feature flag flips on,
// `available` becomes true and the live items/movements tables render instead.
// NO pricing/cost is ever shown. Requesting stock lives on its own Stock Requests
// page now — this view is purely the catalogue / on-hand picture.
export function MyStockView() {
  const [stock, setStock] = React.useState<CustomerStock | null>(null);
  const [catalogue, setCatalogue] = React.useState<CatalogueItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [msg, setMsg] = React.useState<Msg>(null);

  React.useEffect(() => {
    let active = true;
    // Settle the reads independently so a blip on one doesn't blank the other. The
    // catalogue is load-bearing today (stock is flag-gated off), so only a catalogue
    // failure surfaces a page error.
    (async () => {
      const [stockRes, catRes] = await Promise.allSettled([
        customerService.getOwnStock(),
        customerService.getOwnCatalogue(),
      ]);
      if (!active) return;
      if (stockRes.status === "fulfilled") setStock(stockRes.value);
      if (catRes.status === "fulfilled") {
        setCatalogue(catRes.value);
      } else {
        setMsg({
          type: "error",
          text: catRes.reason instanceof Error ? catRes.reason.message : "Could not load your stock.",
        });
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="space-y-6">
        <HeaderCardSkeleton />
        <TableCardSkeleton headers={CATALOGUE_HEADERS} cells={CATALOGUE_SKELETON_CELLS} />
      </div>
    );
  }

  // A catalogue-load failure is fatal (nothing to show).
  if (msg?.type === "error") return <Notice msg={msg} />;

  const liveAvailable = stock?.available ?? false;

  return (
    <div className="space-y-6">
      <PortalHeader title="My Stock" subtitle="The items your stock is tracked against." />

      {!liveAvailable && (
        <div className="flex items-start gap-2.5 rounded-2xl border border-[var(--border)] bg-[var(--accent-10)] px-4 py-3 text-sm text-[var(--ink)]">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--accent)]" />
          <p>
            Live stock levels and movement history are being set up and will appear here soon.
            Below are the items your stock is tracked against.
          </p>
        </div>
      )}

      {liveAvailable ? <LiveStock stock={stock!} /> : <CatalogueTable items={catalogue} />}
    </div>
  );
}

// The customer's stock catalogue — shown until live quantities are available.
function CatalogueTable({ items }: { items: CatalogueItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Boxes}
        title="No catalogue items yet"
        hint="Your stock catalogue hasn't been set up yet. Please contact your account manager."
      />
    );
  }

  return (
    <TableCard headers={CATALOGUE_HEADERS}>
      {items.map((item) => {
        // Unit of measure is now a first-class column; the remaining attributes are
        // free-form custom fields shown in the Details column.
        const custom = Object.entries(item.attributes ?? {}).filter(([, v]) => String(v).trim());
        return (
          <tr key={item.id} className="border-b border-[var(--border)] last:border-0">
            <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{item.sku}</td>
            <td className="px-4 py-3 font-semibold text-[var(--ink)]">{item.name}</td>
            <td className="px-4 py-3 text-[var(--muted)]">{item.category?.name ?? "—"}</td>
            <td className="px-4 py-3 text-[var(--muted)]">{item.uom ?? "—"}</td>
            <td className="px-4 py-3 text-xs text-[var(--muted)]">
              {custom.length > 0 ? custom.map(([k, v]) => `${k}: ${v}`).join(" · ") : "—"}
            </td>
          </tr>
        );
      })}
    </TableCard>
  );
}

// Live stock + movements (rendered once the inventory feature flag is on).
function LiveStock({ stock }: { stock: CustomerStock }) {
  return (
    <div className="space-y-6">
      <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
        <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-extrabold text-[var(--ink)]">
          Stock in warehouse
        </div>
        {stock.items.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[var(--muted)]">No stock on hand.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">SKU</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">On hand</th>
                <th className="px-4 py-3">Tracking</th>
              </tr>
            </thead>
            <tbody>
              {stock.items.map((item) => (
                <tr key={item.sku} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{item.sku}</td>
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{item.name}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{item.category}</td>
                  <td className="px-4 py-3 text-right font-bold text-[var(--ink)]">
                    {item.quantityOnHand}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--muted)]">
                    {item.highValue ? (
                      <span className="inline-flex items-center gap-1 text-[var(--accent)]">
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {item.serial ? `Serial ${item.serial}` : "High value"}
                        {item.location ? ` · ${item.location}` : ""}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {stock.movements.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
          <div className="border-b border-[var(--border)] px-4 py-3 text-sm font-extrabold text-[var(--ink)]">
            Recent movements
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-[11px] font-bold uppercase tracking-wider text-[var(--faint)]">
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Item</th>
                <th className="px-4 py-3">Direction</th>
                <th className="px-4 py-3 text-right">Qty</th>
                <th className="px-4 py-3">Site</th>
              </tr>
            </thead>
            <tbody>
              {stock.movements.map((m, i) => (
                <tr key={`${m.sku}-${i}`} className="border-b border-[var(--border)] last:border-0">
                  <td className="px-4 py-3 text-[var(--muted)]">
                    {new Date(m.date).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3 font-semibold text-[var(--ink)]">{m.name}</td>
                  <td className="px-4 py-3 capitalize text-[var(--muted)]">{m.direction}</td>
                  <td className="px-4 py-3 text-right font-bold text-[var(--ink)]">{m.quantity}</td>
                  <td className="px-4 py-3 text-[var(--muted)]">{m.site ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
