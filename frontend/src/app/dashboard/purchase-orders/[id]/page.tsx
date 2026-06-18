"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { PurchaseOrderDetail } from "@/components/dashboard/purchase-orders/PurchaseOrderDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as poService from "@/services/purchase-order.service";
import type { PurchaseOrder } from "@/types/purchase-order";

// :id may be a database id OR a PO code (the list links by code).
export default function ViewPurchaseOrderPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["purchase_orders.view"]}>
      <PoLoader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function PoLoader({ idOrCode }: { idOrCode: string }) {
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
  // Suspense satisfies useSearchParams (the ?tab= seed) during prerender.
  return <React.Suspense fallback={<FormPageSkeleton />}><PurchaseOrderDetail initial={order} /></React.Suspense>;
}
