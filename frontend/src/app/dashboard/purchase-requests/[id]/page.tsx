"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { PurchaseRequestDetail } from "@/components/dashboard/purchase-requests/PurchaseRequestDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as prfService from "@/services/purchase-request.service";
import type { PurchaseRequest } from "@/types/purchase-request";

// :id may be a database id OR a PRF code (the list links by code).
export default function ViewPurchaseRequestPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["purchase_requests.view"]}>
      <PrfLoader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function PrfLoader({ idOrCode }: { idOrCode: string }) {
  const [request, setRequest] = React.useState<PurchaseRequest | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    prfService
      .getPurchaseRequest(idOrCode)
      .then((prf) => {
        if (active) setRequest(prf);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load this purchase request.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [idOrCode]);

  if (loading) return <FormPageSkeleton />;
  if (error || !request) return <FormError message={error ?? "Purchase request not found."} />;
  // Suspense satisfies useSearchParams (the ?tab= seed) during prerender.
  return <React.Suspense fallback={<FormPageSkeleton />}><PurchaseRequestDetail initial={request} /></React.Suspense>;
}
