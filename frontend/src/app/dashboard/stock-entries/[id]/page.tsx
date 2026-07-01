"use client";

import * as React from "react";
import { useParams } from "next/navigation";

import { PermissionGate } from "@/components/auth/PermissionGate";
import { StockEntryDetail } from "@/components/dashboard/customers/StockEntryDetail";
import { FormError, FormPageSkeleton } from "@/components/ui/FormScaffold";
import * as customerService from "@/services/customer.service";
import type { CustomerStockEntry } from "@/types/customer";

export default function StockEntryPage() {
  const params = useParams();
  const id = String(params.id);

  return (
    <PermissionGate anyOf={["customer_stock.view", "stock_requests.view"]}>
      <EntryLoader key={id} id={id} />
    </PermissionGate>
  );
}

function EntryLoader({ id }: { id: string }) {
  const [entry, setEntry] = React.useState<CustomerStockEntry | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    customerService
      .getStockEntry(id)
      .then((e) => {
        if (active) setEntry(e);
      })
      .catch((e) => {
        if (active) setError(e instanceof Error ? e.message : "Could not load stock entry.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [id]);

  if (loading) return <FormPageSkeleton />;
  if (error || !entry) return <FormError message={error ?? "Stock entry not found."} />;
  // Suspense satisfies useSearchParams (the ?from= context) during prerender.
  return (
    <React.Suspense fallback={<FormPageSkeleton />}>
      <StockEntryDetail initial={entry} />
    </React.Suspense>
  );
}
