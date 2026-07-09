"use client";

import * as React from "react";
import { useParams, useRouter } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { PurchaseRequestForm } from "@/components/dashboard/purchase-requests/PurchaseRequestForm";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as prfService from "@/services/purchase-request.service";
import type { PurchaseRequest } from "@/types/purchase-request";

// :id may be a database id OR a PRF code (the list/detail link by code).
export default function EditPurchaseRequestPage() {
  const params = useParams();
  const idOrCode = String(params.id);

  return (
    <PermissionGate anyOf={["purchase_requests.edit"]}>
      <EditPrfLoader key={idOrCode} idOrCode={idOrCode} />
    </PermissionGate>
  );
}

function EditPrfLoader({ idOrCode }: { idOrCode: string }) {
  const router = useRouter();
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

  // Only Draft purchase requests are editable. Once submitted, the header, supplier,
  // warehouse, quantities and quoted prices are locked — Reject → Draft reopens editing.
  if (request.status !== "draft") {
    return (
      <div className="mx-auto w-full max-w-lg py-16 text-center">
        <p className="text-sm font-extrabold text-[var(--ink)]">This purchase request can&apos;t be edited.</p>
        <p className="mt-1.5 text-xs text-[var(--muted)]">
          Only draft purchase requests are editable. {request.code} is {request.status.replace(/_/g, " ")} — reject or
          reopen it back to draft first to make changes.
        </p>
        <button
          type="button"
          onClick={() => router.push(`/dashboard/purchase-requests/${request.code}`)}
          className="mt-4 inline-flex items-center gap-1.5 rounded-xl bg-[var(--accent)] px-4 py-2 text-xs font-extrabold text-white transition-all hover:opacity-90"
        >
          View purchase request
        </button>
      </div>
    );
  }

  return <PurchaseRequestForm mode="edit" request={request} />;
}
