"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { PurchaseOrderForm } from "@/components/dashboard/purchase-orders/PurchaseOrderForm";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as poService from "@/services/purchase-order.service";
import type { PurchaseOrder } from "@/types/purchase-order";

// :id may be a database id OR a PO code (the list/detail link by code).
export default function EditPurchaseOrderPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["purchase_orders.edit"]}>
      <EditPoLoader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function EditPoLoader({ idOrCode }: { idOrCode: string }) {
  const router = useRouter();
  const [order, setOrder] = React.useState<PurchaseOrder | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    poService
      .getPurchaseOrder(idOrCode)
      .then((po) => {
        if (active) setOrder(po);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this purchase order.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !order) return <FormError message={error ?? "Purchase order not found."} />;

  // Only Draft purchase orders are editable. Once submitted, the header, supplier,
  // warehouse, quantities and prices are locked — Reject → Draft reopens editing.
  if (order.status !== "draft") {
    return (
      <div className="mx-auto w-full max-w-lg py-16 text-center">
        <p className="text-sm font-extrabold text-[var(--ink)]">This purchase order can&apos;t be edited.</p>
        <p className="mt-1.5 text-xs text-[var(--muted)]">
          Only draft purchase orders are editable. {order.code} is {order.status.replace(/_/g, " ")} — reject it back to
          draft first to make changes.
        </p>
        <button
          type="button"
          onClick={() => router.push(`/dashboard/purchase-orders/${order.code}`)}
          className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
        >
          View purchase order
        </button>
      </div>
    );
  }

  return <PurchaseOrderForm mode="edit" order={order} />;
}
